// Folds the notes a card's recorded transcript gained into the board, through the
// writer the caller holds. Read-only towards the transcript. Each note's id derives
// from its source record, so a re-read appends nothing new; harvest.json in the
// board's folder only remembers how far each transcript was read, and deleting it
// costs one full re-read. The settings a transcript gained, such as a model switch
// or a new effort, update the card as an observation of the transcript.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { decideNote, decidePush, noteId } from '../../core/decide.ts'
import { SESSION_TITLE, type SourceNote } from '../../core/model.ts'
import type { Writer } from '../../store/board-store.ts'
import { readTranscript } from '../../search/index.ts'
import { codexThreadTitle, transcriptNotes } from './notes.ts'
import { transcriptSettings, type FoundSettings } from './settings.ts'

const CURSORS = 'harvest.json'

// "<card id>\n<transcript path>" -> how far it was read.
type Cursors = Record<string, { identity: string; pos: number }>

function readCursors(dir: string): Cursors {
  try {
    const value = JSON.parse(readFileSync(join(dir, CURSORS), 'utf8')) as unknown

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Cursors) : {}
  } catch {
    return {}
  }
}

function writeCursors(dir: string, cursors: Cursors): void {
  const tmp = join(dir, `.${CURSORS}.tmp-${process.pid}`)
  writeFileSync(tmp, JSON.stringify(cursors))
  renameSync(tmp, join(dir, CURSORS))
}

// Appends one harvested note to a card; returns 1 when it was new.
export function appendNote(
  writer: Writer,
  cardId: string,
  { ref, ...note }: SourceNote,
  at: string,
): number {
  const card = writer.state.cards[cardId]!
  const decision = decideNote(writer.state, card.id, note, { at, actor: 'harvest', id: noteId(card.key, ref) })

  if (!('event' in decision)) {
    return 0
  }

  writer.append(decision.event)

  return 1
}

// Codex writes a session's thread name to session_index.jsonl in its home, not to
// the transcript at <home>/sessions/YYYY/MM/DD/rollout-*.jsonl.
// ponytail: reads the whole index each time; it is one short line per named thread.
function codexTitle(writer: Writer, cardId: string, path: string, at: string): number {
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

  return codexThreadTitle(index, card.agent.sessionId)
    .reduce((n, note) => n + appendNote(writer, cardId, note, at), 0)
}

// Harvests the transcripts of these cards from where the last read stopped, and
// returns how many notes were appended. A missing transcript waits for its file.
export function harvestTranscripts(writer: Writer, cardIds: Iterable<string>, at: string): number {
  const cursors = readCursors(writer.dir)
  let appended = 0
  let moved = false

  for (const id of cardIds) {
    const path = writer.state.cards[id]?.agent?.transcriptPath

    if (!path || !isAbsolute(path) || !path.endsWith('.jsonl')) {
      continue
    }

    appended += codexTitle(writer, id, path, at)
    const name = `${id}\n${path}`
    const tail = readTranscript({ source: path, ...(cursors[name] ?? { identity: '', pos: 0 }) })

    if (!tail) {
      continue
    }

    const settings: FoundSettings = {}
    const { agent, autoTitle } = writer.state.cards[id]!
    const subagent = agent!.agentId !== undefined
    // The session title the transcript named last before this read.
    let title = tail.reset || !cursors[name]?.pos || autoTitle?.from !== 'session' ? undefined : `${SESSION_TITLE}${autoTitle.text}`

    for (const line of tail.lines) {
      for (const note of transcriptNotes(line.record)) {
        if (note.kind !== 'context' || !note.text.startsWith(SESSION_TITLE)) {
          appended += appendNote(writer, id, note, at)
        } else if (note.text !== title) {
          title = note.text
          appended += appendNote(writer, id, { ...note, ref: `${note.ref}@${line.pos}` }, at)
        }
      }

      Object.assign(settings, transcriptSettings(line.record, subagent))
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
      const decision = decidePush(writer.state, card.key, { settings, source }, { at, actor: 'harvest' })

      if ('event' in decision) {
        writer.append(decision.event)
      }
    }

    cursors[name] = { identity: tail.identity, pos: tail.end }
    moved = true
  }

  if (moved) {
    writeCursors(writer.dir, cursors)
  }

  return appended
}
