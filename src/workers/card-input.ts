import { inform } from '#app/command-notices.ts'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { background } from '#app/background.ts'
import { applyDecision } from '#app/decision.ts'
import { ownerActor } from '#app/actors.ts'
import type { Meta } from '#app/command-meta.ts'
import type { Host, Live } from '#app/host-types.ts'
import type { TitanState } from '#app/model.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { recordContext } from '#titan/file-context.ts'
import { TitanError } from '#store/errors.ts'
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
      clear: 'othrys send --task <task> --text "<message>"',
    })
  }

  const issues = candidateIssues({ value: [agent] })

  if (!text.trim() || issues.length) {
    throw new TitanError({
      message: issues[0]?.problem ?? 'Message is empty',
      code: 'VALIDATION_ERROR',
    })
  }
}

export async function queueCardInput({
  titanId,
  task,
  text,
  agent,
  meta,
}: {
  titanId: string
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

  return await withWriter({
    titanId,
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
          throw new TitanError({
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
            route: 'othrys',
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
  if (card.id === TITAN_CARD) {
    throw new TitanError({
      message: 'Choose a task rather than the Titan',
      code: 'CONFLICT',
    })
  }

  if (card.hidden) {
    inform({
      task: card.id,
      reason: 'Message sent to a hidden task',
      clear: `Review the visibility of task ${card.id} in the UI.`,
    })
  }

  if (card.queue) {
    inform({
      task: card.id,
      reason: 'Message sent while the task remains queued',
      clear: `Review the queue for task ${card.id} in the UI.`,
    })
  }

  const outside = !!card.sessionIds?.length && card.agent?.host !== 'othrys'

  if (outside) {
    throw new TitanError({
      message: 'Continue this worker in Othrys before changing its agent',
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
  titanId,
  live,
  host,
}: {
  titanId: string
  live: Map<string, Live>
  host(): Host
}) {
  const sending = new Set<string>()

  const record = async ({
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
  }) => await withWriter({
    titanId,
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
            route: 'othrys',
            detail,
            worker: {
              agent: reply.worker!.agent,
              session,
            },
          },
          meta: {
            actor: 'othrys',
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
        const history: string[] = []

        if (previous) {
          history.push(recordContext({
            titanId,
            task: card.id,
          }))
          history.push(`Read the previous session ${JSON.stringify(previous)} completely before continuing.`)

          if (current?.transcriptPath) {
            history.push(`Its recorded transcript is ${JSON.stringify(current.transcriptPath)}.`)
          }
        }

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
          titanId,
          task: card.id,
          via: 'othrys',
          harness: targetHarness,
          override,
          replacement: previous,
          folder: previous ? card.folder : undefined,
          inputId: reply.id,
          prompt: [
            history.join(' '),
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
          await record({
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

        const ready = await record({
          card,
          reply,
          state: 'queued',
          session: sessionId({ agent: current! }),
        })

        if (!ready) {
          return
        }

        await host().send({
          card: card.id,
          text: reply.text!,
          actor: 'web',
          direct: true,
          inputId: reply.id,
        })
      }
    } catch (error) {
      await record({
        card,
        reply,
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      sending.delete(card.id)
    }
  }

  const reconcile = ({ state }: { state: TitanState }) => {
    for (const card of Object.values(state.cards)) {
      const reply = card.replies?.find(saved => waitingCardInput({ reply: saved }))

      if (!reply || sending.has(card.id)) {
        continue
      }

      sending.add(card.id)
      // Reconcile can run while a writer is open; sends begin after that transaction commits.
      setImmediate(() => {
        const current = loadTitan({ titanId }).state.cards[card.id]

        if (!current || current.replies?.find(saved => saved.id === reply.id)?.state !== 'queued') {
          sending.delete(card.id)

          return
        }

        background({
          name: 'card.send',
          context: {
            titanId,
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
