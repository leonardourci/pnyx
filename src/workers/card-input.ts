import { inform } from '#app/command-notices.ts'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { background } from '#app/background.ts'
import { applyDecision } from '#app/decision.ts'
import { ownerActor } from '#app/actors.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Host, Live } from '#app/host-types.ts'
import type { HydraState } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HydraError } from '#store/errors.ts'
import { findCard } from '#tasks/push-rules.ts'
import type { Card } from '#tasks/model.ts'
import { candidateIssues } from './dispatch-check.ts'
import type { AgentConfig, Reply } from './model.ts'
import { harnessOf } from './providers.ts'
import { decideReply } from './reply-rules.ts'
import { sessionId } from './session-attachments.ts'
import { startTask } from './start.ts'

export const waitingCardInput = ({ reply }: { reply: Reply }) =>
  !!reply.worker && !reply.worker.session && reply.state === 'queued'

export function validateCardInput({
  text,
  agent,
  actor,
}: {
  text: string
  agent: AgentConfig
  actor: string
}) {
  if (!ownerActor({ actor })) {
    inform({
      reason: 'Message sent from a card by an agent',
      clear: 'pnyx-axi reply <task> --text "<message>"',
    })
  }

  const issues = candidateIssues({ value: [agent] })

  if (!text.trim() || issues.length) {
    throw new HydraError({
      message: issues[0]?.problem ?? 'Message is empty',
      code: 'VALIDATION_ERROR',
    })
  }
}

export function queueCardInput({
  hydraId,
  task,
  text,
  agent,
  meta,
}: {
  hydraId: string
  task: string
  text: string
  agent: AgentConfig
  meta: Meta
}) {
  validateCardInput({
    text,
    agent,
    actor: meta.actor,
  })

  const id = meta.id ?? randomUUID()

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      const card = findCard({
        state: writer.state,
        ref: task,
      })
      const known = card.replies?.find(reply => reply.id === id)

      if (known) {
        if (known.text !== text || !isDeepStrictEqual(
          known.worker?.agent,
          agent,
        )) {
          throw new HydraError({
            message: 'This message ID belongs to another send',
            code: 'CONFLICT',
          })
        }

        if (known.state !== 'failed') {
          return {
            task: card.id,
            reply: id,
            state: known.state,
          }
        }
      }

      requireCardInputTarget({ card })
      applyDecision({
        writer,
        decision: decideReply({
          state: writer.state,
          ref: card.id,
          data: {
            reply: id,
            state: 'queued',
            route: 'pnyx',
            text,
            worker: { agent },
          },
          meta: {
            ...meta,
            id: known ? undefined : `${id}:queued`,
          },
        }),
      })

      return {
        task: card.id,
        reply: id,
        state: 'queued',
      }
    },
  })
}

function requireCardInputTarget({ card }: { card: Card }) {
  if (card.id === HYDRA_CARD) {
    throw new HydraError({
      message: 'Choose a task rather than the Hydra',
      code: 'CONFLICT',
    })
  }

  if (card.hidden) {
    inform({
      task: card.id,
      reason: 'Message sent to a hidden task',
      clear: `Use pnyx-axi task unhide ${card.id} to show it in Hydra`,
    })
  }

  if (card.queue) {
    inform({
      task: card.id,
      reason: 'Message sent while the task remains queued',
      clear: `Use pnyx-axi task unqueue ${card.id} to release its queue`,
    })
  }

  const outside = !!card.sessionIds?.length && card.agent?.host !== 'pnyx'

  if (outside) {
    throw new HydraError({
      message: 'Continue this worker in Pnyx before changing its agent',
      code: 'NO_ROUTE',
    })
  }
}

function agentChange({
  card,
  agent,
}: {
  card: Card
  agent: AgentConfig
}) {
  if (!card.agent) {
    return 'session'
  }

  const harness = harnessOf({ provider: card.agent.provider })
  const changesAccount = agent.account !== undefined && card.agent.account !== agent.account

  if (harness !== agent.harness || changesAccount) {
    return 'session'
  }

  const changesSettings = ([
    'model',
    'effort',
  ] as const).some(setting =>
    agent[setting] !== undefined && agent[setting] !== card.settings?.[setting])

  return changesSettings ? 'settings' : 'none'
}

export function createCardInputs({
  hydraId,
  live,
  host,
}: {
  hydraId: string
  live: Map<string, Live>
  host(): Host
}) {
  const sending = new Set<string>()

  const record = ({
    card,
    reply,
    state,
    detail,
    session,
  }: {
    card: Card
    reply: Reply
    state: 'queued' | 'failed'
    detail?: string
    session?: string
  }) => withWriter({
    hydraId,
    fn: ({ writer }) => {
      const current = writer.state.cards[card.id]?.replies?.find(saved => saved.id === reply.id)

      if (current?.state !== 'queued') {
        return false
      }

      applyDecision({
        writer,
        decision: decideReply({
          state: writer.state,
          ref: card.id,
          data: {
            reply: reply.id,
            state,
            route: 'pnyx',
            detail,
            worker: {
              agent: reply.worker!.agent,
              session,
            },
          },
          meta: {
            actor: 'pnyx',
            at: new Date().toISOString(),
          },
        }),
      })

      return true
    },
  })

  const deliver = async ({
    card,
    reply,
  }: {
    card: Card
    reply: Reply
  }) => {
    try {
      const { agent } = reply.worker!
      const current = card.agent
      const change = agentChange({
        card,
        agent,
      })

      const running = current && live.get(sessionId({ agent: current }))

      if (change !== 'none' && running?.session) {
        await running.session.interrupt({ cancelQueued: false })
      }

      if (change === 'session') {
        const previous = current && sessionId({ agent: current })
        const history = previous
          ? `Read the previous conversation with pnyx-axi task chat ${card.id} --session ${previous} --hydra ${hydraId}. Follow every continuation cursor before continuing.`
          : ''

        if (previous) {
          const released = await host().release({ task: card.id })

          if ('busy' in released) {
            return
          }
        }

        const {
          harness: targetHarness,
          ...override
        } = agent
        const started = await startTask({
          hydraId,
          task: card.id,
          via: 'pnyx',
          harness: targetHarness,
          override,
          replacement: previous,
          folder: previous ? card.folder : undefined,
          inputId: reply.id,
          prompt: [
            history,
            reply.text,
          ].filter(Boolean).join('\n\n'),
          meta: {
            actor: 'web',
            at: new Date().toISOString(),
            id: `card:${reply.id}`,
          },
        })
        const anotherActorHoldsTask = started.launch === 'waiting' || started.launch === 'pending'

        if (anotherActorHoldsTask) {
          record({
            card,
            reply,
            state: 'failed',
            detail: String(started.blocker),
          })
        }
      } else {
        for (const setting of [
          'model',
          'effort',
        ] as const) {
          const value = agent[setting]

          if (value && value !== card.settings?.[setting]) {
            await host().set({
              card: card.id,
              setting,
              value,
              actor: 'web',
            })
          }
        }

        const ready = record({
          card,
          reply,
          state: 'queued',
          session: sessionId({ agent: current! }),
        })

        if (!ready) {
          return
        }

        host().send({
          card: card.id,
          text: reply.text!,
          actor: 'web',
          direct: true,
          inputId: reply.id,
        })
      }
    } catch (error) {
      record({
        card,
        reply,
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      sending.delete(card.id)
    }
  }

  const reconcile = ({ state }: { state: HydraState }) => {
    for (const card of Object.values(state.cards)) {
      const reply = card.replies?.find(saved => waitingCardInput({ reply: saved }))

      if (!reply || sending.has(card.id)) {
        continue
      }

      sending.add(card.id)
      // Reconcile can run while a writer is open; sends begin after that transaction commits.
      setImmediate(() => {
        const current = loadHydra({ hydraId }).state.cards[card.id]

        if (!current || current.replies?.find(saved => saved.id === reply.id)?.state !== 'queued') {
          sending.delete(card.id)

          return
        }

        background({
          name: 'card.send',
          context: {
            hydraId,
            taskId: card.id,
          },
          run: () => deliver({
            card: current,
            reply,
          }),
        })
      })
    }
  }

  return { reconcile }
}
