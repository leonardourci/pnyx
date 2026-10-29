import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider, PermissionDecision, HostedSession } from '#workers/provider.ts'
import type { ProviderId, Summary } from '#agent-host/protocol.ts'
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
  applied?: Record<string, {
    through: number
    at: string
  }>
  answers: Record<string, {
    permission: string
    secret: boolean
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

      if (binding && 'inputs' in binding) {
        delete binding.inputs
      }

      const save = () => writer!.write({ text: () => JSON.stringify(binding) })
      let summary = agent && inventory.findLast(session =>
        session.provider === provider && session.nativeId === agent.sessionId)
      let recovered = false

      if (!summary && reattachOnly && binding?.session) {
        const previous = binding.session.ref
        summary = inventory.find(session => session.ref.id === previous.id
        && session.ref.epoch === previous.epoch)
      }

      if (reattachOnly && !summary) {
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

      if (reattach && (!binding || binding.instance !== client.ready.instance || !summary
        || summary.nativeId !== agent?.sessionId)) {
        fail({
          code: 'RECOVERY_REQUIRED',
          message: 'Retained completion ownership must be reconciled in its original native epoch',
        })
      }

      const terminalReattachment = reattach && (summary?.phase === 'closed' || summary?.phase === 'failed')

      const recoveryReplay = summary?.phase === 'recovery_required' && summary.recovery !== undefined

      if (summary?.phase === 'live' || terminalReattachment || recoveryReplay) {
        recovered = true
      } else if (summary && reattachOnly) {
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

      for (const [
        id,
        answer,
      ] of Object.entries(active.answers)) {
        const result = await client.result({ requestId: id })

        if (result.kind === 'answer') {
          answer.phase = result.receipt.phase
        } else if (result.kind === 'error' && result.code === 'NOT_RECEIVED') {
          answer.phase = 'not_received'
        } else if (result.kind === 'error' && result.code === 'IN_FLIGHT') {
          answer.phase = 'received'
        } else {
          answer.phase = 'unknown'
        }
      }

      await save()
      const session = await remoteSession({
        client,
        summary,
        recovered,
        context,
        readOnly: recoveryReplay || reattachOnly && summary.phase !== 'live',
        requireOutcome: reattachOnly === true && summary.phase !== 'live',
        async persistAnswer({
          permission,
          decision,
        }) {
          const id = `${summary.ref.epoch}:answer:${permission}`
          const previous = active.answers[id]

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
            decision: secret ? undefined : decision,
            phase: 'queued',
          }
          await save()

          return id
        },
        async appliedFact({ fact }) {
          active.applied ??= {}
          active.applied[fact.ref.epoch] = {
            through: fact.seq,
            at: fact.at,
          }
          await save()
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

      session.permissionDelivery = ({ permission }) => {
        const id = `${summary.ref.epoch}:answer:${permission}`

        return active.answers[id]?.phase
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
