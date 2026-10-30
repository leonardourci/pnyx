import { nativeStatus, type NativeStatus } from './native-status.ts'
import { HydraError } from '#store/errors.ts'
import { deferred } from '#agent-host/deferred.ts'
import type { ToClient } from '#agent-host/protocol.ts'
import type { HostClient } from '#agent-host/client.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider, HostedSession } from '#workers/provider.ts'
import type { ProviderId, Result, Summary } from '#agent-host/protocol.ts'
import { fail } from '#agent-host/protocol.ts'
import { nativeConnection } from './native-connection.ts'
import { checked, remoteSession } from '#agent-host/remote.ts'
import { fingerprint } from '#agent-host/ledger.ts'
import { durableWriter } from '#agent-host/durable.ts'
import { privateDir } from '#store/storage.ts'

const SNAPSHOT_MS = 5000

type Binding = {
  request: string
  instance: string
  session?: Summary

}

export async function nativeProviders({
  directory,
  journal,
  installation,
  reconnect,
}: {
  directory: string
  journal: string
  installation: string
  reconnect?(): Promise<void>
}) {
  privateDir({ dir: journal })
  let controller = ''
  let inventory: Summary[] = []
  const client = await nativeConnection({
    socket: join(
      directory,
      'host.sock',
    ),
    installation,
    reconnect,
    token: readFileSync(
      join(
        directory,
        'token',
      ),
      'utf8',
    ),
    capabilities: [
      'controllers',
      'named-requests',
      'critical-outbox',
      'live-owners',
      'volatile-inputs',
      'host-status',
    ],
    attached: async ({ client: connection }) => {
      const claim = checked({
        result: await connection.call({
          id: randomUUID(),
          operation: {
            kind: 'attach',
            scope: { kind: 'host' },
            expectedRevision: connection.ready.hostControllerRevision,
          },
        }),
      })

      if (claim.kind !== 'attached') {
        throw new Error('Missing host controller')
      }

      controller = claim.control.generation
      inventory = connection.ready.sessions

      for (const summary of inventory) {
        if (summary.phase === 'recovery_required') {
          await settleClosedEnds({
            client: connection,
            summary,
          })
        }
      }
    },
  })
  const writers = new Map<string, ReturnType<typeof durableWriter>>()
  const openings = new Map<string, Promise<HostedSession>>()
  let status = nativeStatus({
    readiness: client.ready.readiness,
    build: client.ready.build,
    instance: client.ready.instance,
  })
  const listeners = new Set<() => void>()
  client.subscribe({
    receive({ frame }) {
      if (frame.type === 'reply' && frame.result.kind === 'ok' && frame.result.session) {
        const updated = frame.result.session
        const current = inventory.find(session => session.ref.id === updated.ref.id
          && session.ref.epoch === updated.ref.epoch)

        if (current) {
          Object.assign(
            current,
            updated,
          )
        }
      }

      if (frame.type === 'host-status' || frame.type === 'ready') {
        status = nativeStatus({
          readiness: frame.type === 'ready' ? frame.readiness : frame.status,
          build: client.ready.build,
          instance: client.ready.instance,
        })

        for (const listener of listeners) {
          listener()
        }
      }
    },
  })
  client.onDisconnect({
    receive() {
      status = {
        ...status,
        state: 'unavailable',
        reasons: ['The native owner is unavailable. Reconcile ownership before restarting agents.'],
      }

      for (const listener of listeners) {
        listener()
      }
    },
  })
  const provider = ({ provider }: { provider: ProviderId }): Provider => ({
    remote: true,
    canOpen: () => client.available() && !inventory.some(session => session.phase === 'recovery_required'),
    owns: ({ agent }) => inventory.some(session => {
      const same = session.provider === provider && session.nativeId === agent.sessionId

      return same && (session.phase === 'live' || session.phase === 'recovery_required' && session.recovery !== undefined)
    }),
    recovering({
      cwd,
      env,
    }) {
      if (!client.available()) {
        return undefined
      }

      const candidates = inventory.filter(session => session.provider === provider
        && session.phase === 'recovery_required' && session.recovery !== undefined)

      if (candidates.length === 0) {
        return undefined
      }

      const { binding } = readBinding({
        provider,
        cwd,
        env,
        journal,
      })
      const previous = binding?.session

      if (!previous || previous.provider !== provider) {
        return undefined
      }

      const summary = candidates.find(session => session.ref.id === previous.ref.id
        && session.ref.epoch === previous.ref.epoch)

      if (!summary?.nativeId || summary.nativeId !== previous.nativeId) {
        return undefined
      }

      return {
        provider,
        sessionId: summary.nativeId,
        cwd,
        host: 'pnyx',
        transcriptPath: summary.path,
      }
    },
    async models({
      cwd,
      env,
    }) {
      const result = checked({
        result: await client.call({
          id: randomUUID(),
          operation: {
            kind: 'catalog',
            provider,
            cwd,
            environment: environment({ env }),
          },
        }),
      })

      return result.kind === 'catalog' ? result.models : []
    },
    defaults: async ({ models }) => models,
    async open({
      cwd,
      env,
      agent,
      settings,
      instructions,
      context,
      allow,
      outputSchema,
      reattachOnly,
      reattach,
    }) {
      const stored = readBinding({
        provider,
        cwd,
        env,
        journal,
      })
      const path = stored.path
      let binding = stored.binding
      let writer = writers.get(path)

      if (!writer) {
        writer = durableWriter({ path })
        writers.set(
          path,
          writer,
        )
      }

      if (binding) {
        if ('inputs' in binding) {
          delete binding.inputs
        }

        if ('applied' in binding) {
          delete binding.applied
        }

        if ('answers' in binding) {
          delete binding.answers
        }
      }

      const save = () => writer!.write({ text: () => JSON.stringify(binding) })
      const matching = inventory.filter(session =>
        session.provider === provider && session.nativeId === agent?.sessionId)
      let summary = agent && (matching.find(session => session.phase === 'recovery_required')
        ?? matching.findLast(session => session.phase === 'live') ?? matching.at(-1))
      let recovered = false
      const retained = reattachOnly || reattach

      if (retained && binding?.session) {
        const previous = binding.session.ref
        summary = inventory.find(session => session.ref.id === previous.id
        && session.ref.epoch === previous.epoch)
      }

      if (retained && !summary) {
        fail({
          code: 'RECOVERY_REQUIRED',
          message: 'The retained native binding is unavailable; preserve the original work until reconciled',
        })
      }

      if (!summary && binding) {
        const sameOwner = binding.instance === client.ready.instance
        const cleanPredecessor = binding.instance === client.ready.predecessor

        if (!sameOwner && !cleanPredecessor) {
          fail({
            code: 'RECOVERY_REQUIRED',
            message: 'Native owner changed; reconcile old ownership and retained facts before reopening',
          })
        }

        const previous = binding.instance === client.ready.predecessor && binding.session
          ? {
            kind: 'opened' as const,
            session: {
              ...binding.session,
              phase: 'closed' as const,
            },
          }
          : checked({ result: await client.result({ requestId: binding.request }) })

        if (previous.kind !== 'opened') {
          throw new Error('Native opening is not established')
        }

        const current = inventory.find(session => session.ref.id === previous.session.ref.id)
        summary = current ?? previous.session
      }

      if (reattach && (!binding?.session || !summary
        || binding.session.ref.id !== summary.ref.id
        || binding.session.ref.epoch !== summary.ref.epoch
        || summary.nativeId !== agent?.sessionId)) {
        fail({
          code: 'RECOVERY_REQUIRED',
          message: 'Retained completion ownership must be reconciled in its original native epoch',
        })
      }

      const recoveryReplay = summary?.phase === 'recovery_required' && summary.recovery !== undefined

      if (summary?.phase === 'live' || recoveryReplay || summary && retained) {
        recovered = true
      } else if (summary && summary.phase !== 'closed' && summary.phase !== 'failed') {
        fail({
          code: 'RECOVERY_REQUIRED',
          message: 'The native session has uncertain ownership',
        })
      } else {
        if (inventory.some(session => session.phase === 'recovery_required')) {
          fail({
            code: 'RECOVERY_REQUIRED',
            message: 'Old native ownership must be reconciled before cold resume',
          })
        }

        binding = {
          request: randomUUID(),
          instance: client.ready.instance,
        }
        await save()
        const result = checked({
          result: await client.call({
            id: binding.request,
            operation: {
              kind: 'open',
              controller,
              options: {
                provider,
                cwd,
                settings,
                environment: environment({ env }),
                instructions,
                context: context?.(),
                allow,
                outputSchema,
                resume: agent ? {
                  nativeId: agent.sessionId,
                  path: agent.transcriptPath,
                } : undefined,
              },
            },
          }),
        })

        if (result.kind !== 'opened') {
          throw new Error('Native opening did not return a binding')
        }

        summary = result.session
        inventory.push(summary)
      }

      if (!binding || !summary) {
        fail({
          code: 'RECOVERY_REQUIRED',
          message: 'The durable native binding is missing',
        })
      }

      binding.session = summary
      await save()
      const deliveries = new Map<string, string>()
      const initialAttempt = ({ permission }: { permission: string }) => `${summary.ref.epoch}:answer:${permission}`
      const session = await remoteSession({
        client,
        summary,
        recovered,
        context,
        readOnly: recoveryReplay || retained && summary.phase !== 'live',
        requireOutcome: reattachOnly === true && summary.phase !== 'live',
        async answerId({ permission }) {
          const id = initialAttempt({ permission })
          const phase = deliveryPhase({ result: await client.result({ requestId: id }) })

          if (phase !== 'not_received') {
            fail({
              code: 'DELIVERY_UNKNOWN',
              message: 'Reconcile the existing native answer receipt before another delivery',
            })
          }

          return id
        },
        async completedAnswer({
          answerId,
          phase,
        }) {
          deliveries.set(
            answerId,
            phase,
          )
        },
      })

      for (const permission of session.snapshot().permissions) {
        const id = initialAttempt({ permission: permission.id })
        deliveries.set(
          id,
          deliveryPhase({ result: await client.result({ requestId: id }) }),
        )
      }

      session.permissionDelivery = ({ permission }) =>
        deliveries.get(initialAttempt({ permission }))

      return session
    },
  })

  const adapters = {
    'claude-code': provider({ provider: 'claude-code' }),
    codex: provider({ provider: 'codex' }),
  }

  for (const [
    name,
    adapter,
  ] of Object.entries(adapters)) {
    const open = adapter.open

    adapter.open = ({ ...options }) => {
      const key = options.agent ? `${name}:${options.agent.sessionId}` : JSON.stringify([
        name,
        options.cwd,
        options.env.PNYX_ACTOR ?? '',
      ])
      const pending = openings.get(key)

      if (pending) {
        return pending
      }

      const opening = open(options).finally(() => openings.delete(key))
      openings.set(
        key,
        opening,
      )

      return opening
    }
  }

  return {
    client,
    status: (): NativeStatus => structuredClone(status),
    subscribeStatus({ changed }: { changed(): void }) {
      listeners.add(changed)

      return () => listeners.delete(changed)
    },
    providers: adapters,
    detach: () => client.detach(),
  }
}

function environment({ env }: { env: NodeJS.ProcessEnv }): Record<string, string> {
  const entries = Object.entries(env)
  const present = entries.filter((entry): entry is [string, string] => entry[1] !== undefined)

  return Object.fromEntries(present)
}

export type NativeProviders = Awaited<ReturnType<typeof nativeProviders>>

export type NativeConnection = Pick<NativeProviders, 'providers'> & Partial<Pick<NativeProviders, 'client' | 'status' | 'subscribeStatus'>>

function deliveryPhase({ result }: { result: Result }): string {
  if (result.kind === 'answer') {
    return result.receipt.phase
  }

  if (result.kind === 'error' && result.code === 'NOT_RECEIVED') {
    return 'not_received'
  }

  if (result.kind === 'error' && result.code === 'IN_FLIGHT') {
    return 'received'
  }

  return 'unknown'
}

async function settleClosedEnds({
  client,
  summary,
}: {
  client: HostClient
  summary: Summary
}) {
  const baseline = deferred<Extract<ToClient, { type: 'snapshot' }>>()
  const unsubscribe = client.subscribe({
    receive: ({ frame }) => {
      if (frame.type === 'snapshot' && frame.ref.id === summary.ref.id && frame.ref.epoch === summary.ref.epoch) {
        baseline.resolve(frame)
      }
    },
  })
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    const attached = checked({
      result: await client.call({
        id: randomUUID(),
        operation: {
          kind: 'attach',
          scope: {
            kind: 'session',
            ref: summary.ref,
          },
          expectedRevision: summary.controllerRevision,
        },
      }),
    })

    if (attached.kind !== 'attached') {
      throw new Error('Missing session controller')
    }

    summary.controllerRevision = attached.control.revision
    timeout = setTimeout(
      () => baseline.reject(new HydraError({
        code: 'RECOVERY_REQUIRED',
        message: 'The retained native epoch could not be inspected',
      })),
      SNAPSHOT_MS,
    )

    client.watch({ ref: summary.ref })
    const snapshot = await baseline.promise
    const onlyClosedEnds = snapshot.pendingFacts.every(fact =>
      typeof fact.event === 'object' && fact.event.type === 'ended' && fact.event.reason === 'closed')
    const last = snapshot.pendingFacts.at(-1)

    if (!onlyClosedEnds || !last || snapshot.snapshot.retention !== 'healthy') {
      return
    }

    const result = checked({
      result: await client.acknowledge({
        ref: summary.ref,
        controller: attached.control.generation,
        through: last.seq,
      }),
    })

    if (result.kind === 'ok' && result.session) {
      Object.assign(
        summary,
        result.session,
      )
    }
  } finally {
    clearTimeout(timeout)
    unsubscribe()
  }
}

function readBinding({
  provider,
  cwd,
  env,
  journal,
}: {
  provider: ProviderId
  cwd: string
  env: NodeJS.ProcessEnv
  journal: string
}): {
  path: string
  binding: Binding | undefined
} {
  const key = fingerprint({
    value: {
      provider,
      cwd,
      actor: env.PNYX_ACTOR ?? '',
    },
  })
  const path = join(
    journal,
    `${key}.json`,
  )
  const binding: Binding | undefined = existsSync(path) ? JSON.parse(readFileSync(
    path,
    'utf8',
  )) : undefined

  return {
    path,
    binding,
  }
}
