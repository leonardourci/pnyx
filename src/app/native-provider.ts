import { nativeStatus, type NativeStatus } from './native-status.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider, PermissionDecision, HostedSession } from '#workers/provider.ts'
import type { ProviderId, Result, Summary } from '#agent-host/protocol.ts'
import { fail } from '#agent-host/protocol.ts'
import { nativeConnection } from './native-connection.ts'
import { checked, remoteSession } from '#agent-host/remote.ts'
import { fingerprint } from '#agent-host/ledger.ts'
import { durableWriter } from '#agent-host/durable.ts'
import { privateDir } from '#store/storage.ts'

type Binding = {
  request: string
  instance: string
  session?: Summary
  answers: Record<string, {
    permission: string
    secret: boolean
    supersedes?: string
    decision?: PermissionDecision
    phase: string
  }>
}

export async function nativeProviders({
  directory,
  journal,
  installation,
}: {
  directory: string
  journal: string
  installation: string
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
    },
  })
  const writers = new Map<string, ReturnType<typeof durableWriter>>()
  const openings = new Map<string, Promise<HostedSession>>()
  let status = nativeStatus({
    maintenance: client.ready.maintenance ?? {
      mode: 'ready',
      blockers: [],
    },
    build: client.ready.build,
    instance: client.ready.instance,
  })
  const listeners = new Set<() => void>()
  client.subscribe({
    receive({ frame }) {
      if (frame.type === 'host-status') {
        status = nativeStatus({
          maintenance: frame.status,
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
      let binding: Binding | undefined = existsSync(path) ? JSON.parse(readFileSync(
        path,
        'utf8',
      )) : undefined
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
      }

      const save = () => writer!.write({ text: () => JSON.stringify(binding) })
      let summary = agent && inventory.findLast(session =>
        session.provider === provider && session.nativeId === agent.sessionId)
      let recovered = false
      const retained = reattachOnly || reattach

      if (!summary && retained && binding?.session) {
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
        if (client.ready.sessions.some(session => session.phase === 'recovery_required')) {
          fail({
            code: 'RECOVERY_REQUIRED',
            message: 'Old native ownership must be reconciled before cold resume',
          })
        }

        binding = {
          request: randomUUID(),
          instance: client.ready.instance,
          answers: {},
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
      const active = binding
      const initialAttempt = ({ permission }: { permission: string }) => `${summary.ref.epoch}:answer:${permission}`

      for (const [
        id,
        answer,
      ] of Object.entries(active.answers)) {
        const result = await client.result({ requestId: id })

        answer.phase = deliveryPhase({ result })
      }

      await save()
      const session = await remoteSession({
        client,
        summary,
        recovered,
        context,
        readOnly: recoveryReplay || retained && summary.phase !== 'live',
        requireOutcome: reattachOnly === true && summary.phase !== 'live',
        async persistAnswer({
          permission,
          decision,
        }) {
          const prefix = initialAttempt({ permission })
          const prior = Object.entries(active.answers).filter(([
            , answer,
          ]) => answer.permission === permission)
            .at(-1)
          const previous = prior?.[1]
          const id = previous?.secret && previous.phase === 'not_received' ? `${prefix}:reentry:${randomUUID()}` : prefix

          if (previous && previous.phase !== 'not_received') {
            fail({
              code: 'DELIVERY_UNKNOWN',
              message: 'Reconcile the existing native answer receipt before another delivery',
            })
          }

          const secret = decision.behavior === 'allow' && (!!decision.answers || !!decision.values)
          active.answers[id] = {
            permission,
            secret,
            supersedes: id === prefix ? undefined : prior?.[0],
            decision: secret ? undefined : decision,
            phase: 'queued',
          }
          await save()

          return id
        },
        async completedAnswer({

          answerId,
          phase,
        }) {
          const answer = active.answers[answerId]

          if (answer && answer.phase !== phase) {
            answer.phase = phase
            await save()
          }
        },
      })

      // This stable ID survives a crash before the decision's journal write.
      for (const permission of session.snapshot().permissions) {
        if (Object.values(active.answers).some(answer => answer.permission === permission.id)) {
          continue
        }

        const id = initialAttempt({ permission: permission.id })
        const result = await client.result({ requestId: id })
        active.answers[id] = {
          permission: permission.id,
          secret: true,
          phase: deliveryPhase({ result }),
        }
        await save()
      }

      session.permissionDelivery = ({ permission }) => {
        return Object.values(active.answers).filter(answer => answer.permission === permission)
          .at(-1)?.phase
      }

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

export type NativeConnection = Pick<NativeProviders, 'providers'> & Partial<Pick<NativeProviders, 'status' | 'subscribeStatus'>>

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
