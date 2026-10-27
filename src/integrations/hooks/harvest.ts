import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { decideNote, decidePush, noteId } from '../../core/decide.ts'
import { SESSION_TITLE, type AgentSession, type SessionEvent, type SourceNote } from '../../core/model.ts'
import { EVENT_VERSION } from '../../store/events.ts'
import { cardSessionId, taskForMessage } from '../../core/tasks.ts'
import { recordEntries } from '../../thread/read.ts'
import type { Writer } from '../../app/writer.ts'
import { readTranscript } from '../../oracle/index.ts'
import { redact } from '../../oracle/text.ts'
import { codexThreadTitle, transcriptNotes } from './notes.ts'
import { LIVE_HOOK_SETTINGS, observedSettings, transcriptSettings, type FoundSettings } from './settings.ts'

const CURSORS = 'harvest.json'

// "<card id>\n<transcript path>" -> how far it was read.
type Cursors = Record<string, {
  identity: string
  pos: number
}>

function readCursors({ dir }: { dir: string }): Cursors {
  try {
    const value = JSON.parse(readFileSync(
      join(
        dir,
        CURSORS,
      ),
      'utf8',
    )) as unknown

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Cursors) : {}
  } catch {
    return {}
  }
}

function writeCursors({
  dir,
  cursors,
}: {
  dir: string
  cursors: Cursors
}): void {
  const tmp = join(
    dir,
    `.${CURSORS}.tmp-${process.pid}`,
  )
  writeFileSync(
    tmp,
    JSON.stringify(cursors),
  )
  renameSync(
    tmp,
    join(
      dir,
      CURSORS,
    ),
  )
}

export function appendNote(
  {
    writer,
    cardId,
    note: {
      ref,
      ...note
    },
    at,
  }: {
    writer: Writer
    cardId: string
    note: SourceNote
    at: string
  },
): number {
  const card = writer.state.cards[cardId]!
  const decision = decideNote({
    state: writer.state,
    ref: card.id,
    note,
    meta: {
      at,
      actor: 'harvest',
      id: noteId({
        cardKey: card.key,
        ref,
      }),
    },
  })

  if (!('event' in decision)) {
    return 0
  }

  writer.append({ event: decision.event })

  return 1
}

// Codex writes a session's thread name to session_index.jsonl in its home, not to
// the transcript at <home>/sessions/YYYY/MM/DD/rollout-*.jsonl.
// ponytail: reads the whole index each time; it is one short line per named thread.
function codexTitle({
  writer,
  cardId,
  path,
  at,
}: {
  writer: Writer
  cardId: string
  path: string
  at: string
}): number {
  const card = writer.state.cards[cardId]!
  const sessions = dirname(dirname(dirname(dirname(path))))

  if (card.agent?.provider !== 'codex' || card.agent.agentId || basename(sessions) !== 'sessions') {
    return 0
  }

  let index: string

  try {
    index = readFileSync(
      join(
        dirname(sessions),
        'session_index.jsonl',
      ),
      'utf8',
    )
  } catch {
    return 0
  }

  const shown = card.autoTitle?.from === 'session' ? `${SESSION_TITLE}${card.autoTitle.text}` : undefined

  return codexThreadTitle({
    index,
    sessionId: card.agent.sessionId,
  })
    .filter(note => note.text !== shown)
    .reduce(
      (
        n,
        note,
      ) => n + appendNote({
        writer,
        cardId,
        note,
        at,
      }),
      0,
    )
}

export function harvestTranscripts({
  writer,
  cardIds,
  at,
  detached,
}: {
  writer: Writer
  cardIds: Iterable<string>
  at: string
  detached?: {
    session: AgentSession
    task: string
    memberships: SessionEvent[]
  }
}): number {
  const cursors = readCursors({ dir: writer.dir })
  let appended = 0
  let moved = false

  for (const id of cardIds) {
    const path = detached?.session.agent.transcriptPath
      ?? writer.state.cards[id]?.agent?.transcriptPath

    if (!path || !isAbsolute(path) || !path.endsWith('.jsonl')) {
      continue
    }

    if (!detached) {
      appended += codexTitle({
        writer,
        cardId: id,
        path,
        at,
      })
    }

    const name = `${id}\n${path}`
    const tail = readTranscript({
      cursor: {
        source: path,
        ...(cursors[name] ?? {
          identity: '',
          pos: 0,
        }),
      },
    })

    if (!tail) {
      continue
    }

    const settings: FoundSettings = {}
    const source = {
      ...writer.state.cards[id]!,
      ...(detached ? {
        agent: detached.session.agent,
        sourceRefs: detached.session.sourceRefs,
        settings: detached.session.settings,
      } : {}),
    }
    const {
      agent,
      autoTitle,
      sourceRefs,
      settings: held,
    } = source
    // The transcript is written after the fact and read later, so a record older than
    // the session's latest hook never overrides a value of a setting hooks report live.
    const hooked = Math.max(
      0,
      ...sourceRefs.filter(r => r.adapter === 'hooks')
        .map(r => Date.parse(r.observedAt ?? '') || 0),
    )
    const live = (LIVE_HOOK_SETTINGS[agent!.provider] ?? [])
      .filter(name => held?.[name] !== undefined)
    const subagent = agent!.agentId !== undefined
    // The session title the transcript named last before this read.
    let title = tail.reset || !cursors[name]?.pos || autoTitle?.from !== 'session' ? undefined : `${SESSION_TITLE}${autoTitle.text}`

    for (const line of tail.lines) {
      const card = writer.state.cards[id]!
      const session = detached?.session.id ?? cardSessionId({ card })

      if (session && (detached || card.tracking === 'declared' || id === '$hydra')) {
        for (const entry of recordEntries({
          record: line.record,
          offset: line.pos,
        }).filter(e => e.kind === 'message')) {
          const messageId = noteId({
            cardKey: session,
            ref: `chat:${path}:${tail.identity}:${entry.id}:${entry.text}`,
          })

          if (!(messageId in writer.state.eventIds)) {
            writer.append({
              event: {
                v: EVENT_VERSION,
                seq: writer.state.seq + 1,
                id: messageId,
                at: entry.at ?? at,
                actor: `session:${session}`,
                cardId: detached ? taskForMessage({
                  memberships: detached.memberships,
                  fallback: detached.task,
                  at: entry.at,
                }) : id,
                agentId: `${agent!.provider}:${agent!.agentId ?? agent!.sessionId}`,
                type: 'chat.message',
                sessionId: session,
                messageId,
                data: {
                  session,
                  nativeId: entry.id,
                  role: entry.role,
                  text: redact({ text: entry.text }),
                },
              },
            })
          }
        }
      }

      for (const note of transcriptNotes({ record: line.record })) {
        if (note.kind !== 'context' || !note.text.startsWith(SESSION_TITLE)) {
          appended += appendNote({
            writer,
            cardId: id,
            note,
            at,
          })
        } else if (note.text !== title) {
          title = note.text
          appended += appendNote({
            writer,
            cardId: id,
            note: {
              ...note,
              ref: `${note.ref}@${line.pos}`,
            },
            at,
          })
        }
      }

      const found = observedSettings({
        agent: agent!,
        held,
        observed: transcriptSettings({
          record: line.record,
          subagent,
        }),
      })
      const stamp = Date.parse(String((line.record as { timestamp?: unknown }).timestamp))
      const stale = hooked > 0 && !(stamp >= hooked)

      Object.assign(
        settings,
        stale
          ? Object.fromEntries(Object.entries(found ?? {}).filter(([name]) => !live.includes(name)))
          : found,
      )
    }

    const card = writer.state.cards[id]!

    const changed = Object.entries(settings)
      .some(([
        name,
        value,
      ]) => (card.settings?.[name] ?? null) !== value)

    if (changed && !detached) {
      const source = {
        adapter: 'transcript',
        instanceId: card.agent!.provider,
        objectId: path,
        observedAt: at,
      }
      const decision = decidePush({
        state: writer.state,
        key: card.key,
        input: {
          settings,
          source,
        },
        meta: {
          at,
          actor: 'harvest',
        },
      })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }
    }

    cursors[name] = {
      identity: tail.identity,
      pos: tail.end,
    }
    moved = true
  }

  if (moved) {
    writeCursors({
      dir: writer.dir,
      cursors,
    })
  }

  return appended
}
