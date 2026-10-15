// Folds the notes a card's recorded transcript gained into the board, through the
// writer the caller holds. Read-only towards the transcript. Each note's id derives
// from its source record, so a re-read appends nothing new; harvest.json in the
// board's folder only remembers how far each transcript was read, and deleting it
// costs one full re-read. The settings a transcript gained, such as a model switch
// or a new effort, update the card as an observation of the transcript.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { decideNote, decidePush, noteId } from '../../core/decide.ts'
import { EVENT_VERSION, SESSION_TITLE, type SourceNote } from '../../core/model.ts'
import { cardSessionId } from '../../core/tasks.ts'
import { recordEntries } from '../../thread/read.ts'
import type { Writer } from '../../store/board-store.ts'
import { readTranscript } from '../../search/index.ts'
import { redact } from '../../search/text.ts'
import { codexThreadTitle, transcriptNotes } from './notes.ts'
import { LIVE_HOOK_SETTINGS, transcriptSettings, type FoundSettings } from './settings.ts'

const CURSORS = 'harvest.json'

// "<card id>\n<transcript path>" -> how far it was read.
type Cursors = Record<string, { identity: string; pos: number }>

function readCursors({ dir }: { dir: string }): Cursors {
  try {
    const value = JSON.parse(readFileSync(join(dir, CURSORS), 'utf8')) as unknown

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Cursors) : {}
  } catch {
    return {}
  }
}

function writeCursors({ dir, cursors }: { dir: string; cursors: Cursors }): void {
  const tmp = join(dir, `.${CURSORS}.tmp-${process.pid}`)
  writeFileSync(tmp, JSON.stringify(cursors))
  renameSync(tmp, join(dir, CURSORS))
}

// Appends one harvested note to a card; returns 1 when it was new.
export function appendNote(
  { writer, cardId, note: { ref, ...note }, at }: {
    writer: Writer
    cardId: string
    note: SourceNote
    at: string
  },
): number {
  const card = writer.state.cards[cardId]!
  const decision = decideNote({ state: writer.state, ref: card.id, note, meta: { at, actor: 'harvest', id: noteId({ cardKey: card.key, ref }) } })

  if (!('event' in decision)) {
    return 0
  }

  writer.append({ event: decision.event })

  return 1
}

// Codex writes a session's thread name to session_index.jsonl in its home, not to
// the transcript at <home>/sessions/YYYY/MM/DD/rollout-*.jsonl.
// ponytail: reads the whole index each time; it is one short line per named thread.
function codexTitle({ writer, cardId, path, at }: {
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
    index = readFileSync(join(dirname(sessions), 'session_index.jsonl'), 'utf8')
  } catch {
    return 0
  }

  const shown = card.autoTitle?.from === 'session' ? `${SESSION_TITLE}${card.autoTitle.text}` : undefined

  return codexThreadTitle({ index, sessionId: card.agent.sessionId })
    .filter(note => note.text !== shown)
    .reduce((n, note) => n + appendNote({ writer, cardId, note, at }), 0)
}

// Harvests the transcripts of these cards from where the last read stopped, and
// returns how many notes were appended. A missing transcript waits for its file.
export function harvestTranscripts({ writer, cardIds, at }: {
  writer: Writer
  cardIds: Iterable<string>
  at: string
}): number {
  const cursors = readCursors({ dir: writer.dir })
  let appended = 0
  let moved = false

  for (const id of cardIds) {
    const path = writer.state.cards[id]?.agent?.transcriptPath

    if (!path || !isAbsolute(path) || !path.endsWith('.jsonl')) {
      continue
    }

    appended += codexTitle({ writer, cardId: id, path, at })
    const name = `${id}\n${path}`
    const tail = readTranscript({ cursor: { source: path, ...(cursors[name] ?? { identity: '', pos: 0 }) } })

    if (!tail) {
      continue
    }

    const settings: FoundSettings = {}
    const { agent, autoTitle, sourceRefs, settings: held } = writer.state.cards[id]!
    // The transcript is written after the fact and read later, so a record older than
    // the session's latest hook never overrides a value of a setting hooks report live.
    const hooked = Math.max(0, ...sourceRefs.filter(r => r.adapter === 'hooks')
      .map(r => Date.parse(r.observedAt ?? '') || 0))
    const live = (LIVE_HOOK_SETTINGS[agent!.provider] ?? [])
      .filter(name => held?.[name] !== undefined)
    const subagent = agent!.agentId !== undefined
    // The session title the transcript named last before this read.
    let title = tail.reset || !cursors[name]?.pos || autoTitle?.from !== 'session' ? undefined : `${SESSION_TITLE}${autoTitle.text}`

    for (const line of tail.lines) {
      const card = writer.state.cards[id]!
      const session = cardSessionId({ card })

      if (session && (card.tracking === 'declared' || id === '$hydra')) {
        for (const entry of recordEntries({ record: line.record, offset: line.pos }).filter(e => e.kind === 'message')) {
          const messageId = noteId({ cardKey: session, ref: `chat:${path}:${tail.identity}:${entry.id}:${entry.text}` })

          if (!(messageId in writer.state.eventIds)) {
            writer.append({
              event: {
                v: EVENT_VERSION,
                seq: writer.state.seq + 1,
                id: messageId,
                at: entry.at ?? at,
                actor: `session:${session}`,
                cardId: id,
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
          appended += appendNote({ writer, cardId: id, note, at })
        } else if (note.text !== title) {
          title = note.text
          appended += appendNote({ writer, cardId: id, note: { ...note, ref: `${note.ref}@${line.pos}` }, at })
        }
      }

      const found = transcriptSettings({ record: line.record, subagent })
      const stamp = Date.parse(String((line.record as { timestamp?: unknown }).timestamp))
      const stale = hooked > 0 && !(stamp >= hooked)

      Object.assign(settings, stale
        ? Object.fromEntries(Object.entries(found ?? {}).filter(([name]) => !live.includes(name)))
        : found)
    }

    const card = writer.state.cards[id]!

    // Only a change is recorded: re-reading the same settings appends nothing.
    const changed = Object.entries(settings)
      .some(([name, value]) => (card.settings?.[name] ?? null) !== value)

    if (changed) {
      const source = {
        adapter: 'transcript',
        instanceId: card.agent!.provider,
        objectId: path,
        observedAt: at,
      }
      const decision = decidePush({ state: writer.state, key: card.key, input: { settings, source }, meta: { at, actor: 'harvest' } })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }
    }

    cursors[name] = { identity: tail.identity, pos: tail.end }
    moved = true
  }

  if (moved) {
    writeCursors({ dir: writer.dir, cursors })
  }

  return appended
}
