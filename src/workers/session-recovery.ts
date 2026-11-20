import { loadHydra } from '#app/store.ts'
import { log } from '#app/diagnostics.ts'
import { withWriter } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { readTranscript } from './transcript-read.ts'
import { readTranscriptRecord } from './transcripts.ts'
import { decideSessionFacts } from './session-facts.ts'

const ACTIVITY_READ_BYTES = 1024 * 1024

export function restoreOutsideSessions({ hydraId }: { hydraId: string }): void {
  const state = loadHydra({ hydraId }).state

  for (const session of Object.values(state.sessions ?? {})) {
    const path = session.agent.transcriptPath

    if (session.agent.host || !path) {
      continue
    }

    let cursor = session.activityCursor?.source === path
      ? { ...session.activityCursor } : {
        source: path,
        identity: '',
        pos: 0,
      }
    let through: number | undefined
    let pending = true

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

        if (through === undefined) {
          through = tail.size
        }

        withWriter({
          hydraId,
          fn: ({ writer }) => {
            for (const line of tail.lines) {
              const current = writer.state.sessions?.[session.id]

              if (!current) {
                return
              }

              const parsed = readTranscriptRecord({
                record: line.record,
                subagent: Boolean(current.agent.agentId),
              })
              const observedAt = Date.parse(parsed.at ?? '')
              const knownAt = Date.parse(current.activityObservedAt ?? '')

              if (!parsed.activity || !parsed.at || !Number.isFinite(observedAt)
              || (Number.isFinite(knownAt) && observedAt < knownAt)) {
                continue
              }

              applyDecision({
                writer,
                decision: decideSessionFacts({
                  state: writer.state,
                  session: current,
                  fields: {
                    agent: current.agent,
                    activity: parsed.activity,
                  },
                  source: {
                    adapter: 'transcript',
                    objectId: path,
                    observedAt: parsed.at,
                  },
                  meta: {
                    at: parsed.at,
                    actor: 'pnyx',
                  },
                }),
              })
            }

            const current = writer.state.sessions?.[session.id]

            if (current) {
              applyDecision({
                writer,
                decision: decideSessionFacts({
                  state: writer.state,
                  session: current,
                  fields: { agent: current.agent },
                  cursor: {
                    source: path,
                    identity: tail.identity,
                    pos: tail.end,
                  },
                  meta: {
                    at: new Date().toISOString(),
                    actor: 'pnyx',
                  },
                }),
              })
            }
          },
        })
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
        hydraId,
        sessionId: session.id,
        error,
      })
    }
  }
}
