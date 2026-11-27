import { loadTitan } from '#app/store.ts'
import { log } from '#app/diagnostics.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { readTranscript } from './transcript-read.ts'
import { readTranscriptRecord } from './transcripts.ts'
import { resumeMessage } from './host.ts'
import { decideSessionFacts, turnChange } from './session-facts.ts'
import { acknowledgeSteering, recordSteeringAttempt } from './inbox.ts'
import { readSteeringMessages } from './inbox-notice.ts'
import { steeringClaim, steeringWorkerIdentity } from './steering.ts'
import { cardSessionId, memoryOnlySession } from './session-attachments.ts'
import type { AgentSession } from './model.ts'
import type { TranscriptRecord } from './provider.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { compactCommand } from './compact-command.ts'

const ACTIVITY_READ_BYTES = 1024 * 1024

export async function restoreSessionActivity({ titanId }: { titanId: string }): Promise<void> {
  const state = loadTitan({ titanId }).state

  for (const session of Object.values(state.sessions ?? {})) {
    const path = session.agent.transcriptPath

    if (!path || memoryOnlySession({
      state,
      session,
    })) {
      continue
    }

    let cursor = {
      source: path,
      identity: '',
      pos: session.transcriptPos ?? 0,
    }
    let through: number | undefined
    let pending = true
    let manualCompact = false
    const readInstructions = new Map<string, string>()

    try {
      while (pending) {
        const tail = readTranscript({
          cursor,
          through,
          maxBytes: ACTIVITY_READ_BYTES,
        })

        if (!tail || (tail.end === cursor.pos && !tail.reset)) {
          break
        }

        if (through === undefined || tail.reset) {
          through = tail.size
        }

        if (tail.reset) {
          manualCompact = false
          readInstructions.clear()
        }

        const committed = await withWriter({
          titanId,
          fn: ({ writer }) => {
            const bound = writer.state.sessions?.[session.id]

            if (!bound || bound.agent.transcriptPath !== path) {
              return false
            }

            let lastRepeat: (() => void) | undefined

            for (const line of tail.lines) {
              const current = writer.state.sessions?.[session.id] ?? bound

              const parsed = readTranscriptRecord({
                record: line.record,
                subagent: Boolean(current.agent.agentId),
              })
              const observedAt = Date.parse(parsed.at ?? '')

              if (!parsed.at || !Number.isFinite(observedAt)) {
                continue
              }

              const resumed = parsed.messages.some(resumeMessage)

              if (resumed) {
                readInstructions.clear()
              }

              if (parsed.role === 'user') {
                manualCompact = parsed.messages.some(message => compactCommand({
                  text: message.text,
                }))
              }

              const taken = takenTexts({ parsed })

              if (taken.length) {
                const inputs = new Map<string, string>()

                for (const text of taken) {
                  const ids = readSteeringMessages({
                    text,
                    task: current.taskId ?? '',
                  })

                  for (const id of ids) {
                    inputs.set(
                      id,
                      parsed.at,
                    )
                    readInstructions.set(
                      id,
                      parsed.at,
                    )
                  }
                }

                restoreInstructionReceipts({
                  writer,
                  session: current,
                  inputs,
                  receipt: {
                    type: 'notice',
                    id: `native-notice:${current.id}:${line.pos}`,
                  },
                })
              }

              if (parsed.final) {
                restoreInstructionReceipts({
                  writer,
                  session: current,
                  inputs: readInstructions,
                  receipt: { type: 'read' },
                })
                readInstructions.clear()
              }

              const activity = parsed.contextReset && manualCompact ? 'finished' : parsed.activity

              if (!activity) {
                continue
              }

              const attention = activity === 'finished' ? [] : undefined
              const at = parsed.at
              const native = `native-activity:${session.id}:${line.pos}`
              const id = resumed ? `resume:${native}` : native
              const observe = () => applyDecision({
                writer,
                decision: decideSessionFacts({
                  state: writer.state,
                  session: writer.state.sessions?.[session.id] ?? bound,
                  fields: {
                    agent: current.agent,
                    activity,
                    attention,
                  },
                  source: {
                    adapter: 'transcript',
                    instanceId: tail.identity,
                    generation: line.pos,
                    cursor: parsed.inputUuid,
                    objectId: path,
                    observedAt: at,
                  },
                  meta: {
                    at,
                    actor: 'othrys',
                    id,
                  },
                }),
              })
              const namesInput = parsed.inputUuid !== undefined
              const changes = namesInput || turnChange({
                session: current,
                agent: current.agent,
                activity,
                eventId: id,
              })

              if (changes) {
                lastRepeat = undefined
                observe()
              } else {
                lastRepeat = observe
              }
            }

            lastRepeat?.()

            return true
          },
        })

        if (!committed) {
          break
        }

        cursor = {
          source: path,
          identity: tail.identity,
          pos: tail.end,
        }
        pending = cursor.pos < through
      }
    } catch (error) {
      log({
        level: 'warn',
        operation: 'session activity recovery',
        titanId,
        sessionId: session.id,
        error,
      })
    }
  }
}

function takenTexts({ parsed }: { parsed: TranscriptRecord }): string[] {
  if (parsed.role === 'user') {
    return parsed.messages.map(message => message.text)
  }

  return parsed.folded === undefined ? [] : [parsed.folded]
}

function restoreInstructionReceipts({
  writer,
  session,
  inputs,
  receipt,
}: {
  writer: Writer
  session: AgentSession
  inputs: ReadonlyMap<string, string>
  receipt: {
    type: 'notice'
    id: string
  } | { type: 'read' }
}): void {
  const card = writer.state.cards[session.taskId ?? '']

  if (!card || card.id === TITAN_CARD || cardSessionId({ card }) !== session.id) {
    return
  }

  const claim = steeringClaim({ card })

  if (!claim) {
    return
  }

  const actor = `worker:${card.id}`

  for (const message of card.steering ?? []) {
    const at = inputs.get(message.id)
    const recordedAfterQueue = at !== undefined && Date.parse(message.at) <= Date.parse(at)

    if (message.ack || message.stopped || !at || !recordedAfterQueue) {
      continue
    }

    if (receipt.type === 'notice') {
      if (!message.attempts.length) {
        recordSteeringAttempt({
          writer,
          ref: card.id,
          id: message.id,
          attempt: {
            id: `${receipt.id}:${message.id}`,
            at,
            actor: 'othrys',
            claim,
            result: 'delivered',
          },
          meta: {
            at,
            actor: 'othrys',
          },
        })
      }

      continue
    }

    acknowledgeSteering({
      derived: true,
      writer,
      ref: card.id,
      id: message.id,
      ack: {
        at,
        actor,
        claim,
        outcome: 'read',
      },
      meta: {
        at,
        actor,
      },
      worker: steeringWorkerIdentity({
        state: writer.state,
        card,
      }),
    })
  }
}
