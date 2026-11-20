import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { readTranscript } from './transcript-read.ts'
import { readTranscriptRecord } from './transcripts.ts'
import { decideSessionFacts } from './session-facts.ts'

export function restoreOutsideSessions({ hydraId }: { hydraId: string }): void {
  const state = loadHydra({ hydraId }).state

  for (const session of Object.values(state.sessions ?? {})) {
    const path = session.agent.transcriptPath

    if (session.agent.host || !path) {
      continue
    }

    const tail = readTranscript({
      cursor: {
        source: path,
        identity: '',
        pos: 0,
      },
    })
    let latest: {
      activity: string
      at: string
    } | undefined

    for (const line of tail?.lines ?? []) {
      const parsed = readTranscriptRecord({
        record: line.record,
        subagent: Boolean(session.agent.agentId),
      })

      const observedAt = Date.parse(parsed.at ?? '')
      const seenAt = Date.parse(session.lastSeen ?? '')
      const newer = !Number.isFinite(seenAt) || observedAt > seenAt

      if (parsed.activity && parsed.at && Number.isFinite(observedAt) && newer) {
        latest = {
          activity: parsed.activity,
          at: parsed.at,
        }
      }
    }

    if (!latest || latest.activity === session.sessionActivity) {
      continue
    }

    const observed = latest
    withWriter({
      hydraId,
      fn: ({ writer }) => {
        const current = writer.state.sessions?.[session.id]

        if (!current) {
          return
        }

        applyDecision({
          writer,
          decision: decideSessionFacts({
            state: writer.state,
            session: current,
            task: current.taskId ? writer.state.cards[current.taskId] : undefined,
            fields: {
              agent: current.agent,
              activity: observed.activity,
            },
            source: {
              adapter: 'transcript',
              objectId: path,
              observedAt: observed.at,
            },
            meta: {
              at: observed.at,
              actor: 'pnyx',
            },
          }),
        })
      },
    })
  }
}
