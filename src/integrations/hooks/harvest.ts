import { readTranscriptRecord } from '#workers/transcripts.ts'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { decideNote, noteId } from '#tasks/notes.ts'
import { decidePush } from '#tasks/push.ts'
import { SESSION_TITLE, type SourceNote } from '#tasks/model.ts'
import { cardSessionId } from '#workers/session-attachments.ts'
import type { Writer } from '#app/writer.ts'
import { readTranscript } from '#workers/transcript-read.ts'
import { codexThreadTitle } from '#workers/codex.ts'
import type { FoundSettings } from '#workers/provider.ts'
import { LIVE_HOOK_SETTINGS, observedSettings } from './settings.ts'

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

// A task moving to another Hydra reads its transcripts on from where this Hydra stopped,
// so no note is recorded twice.
export function carryCursors({
  from,
  to,
  card,
}: {
  from: string
  to: string
  card: string
}): void {
  const prefix = `${card}\n`
  const carried = Object.entries(readCursors({ dir: from }))
    .filter(([name]) => name.startsWith(prefix))

  if (!carried.length) {
    return
  }

  writeCursors({
    dir: to,
    cursors: {
      ...readCursors({ dir: to }),
      ...Object.fromEntries(carried),
    },
  })
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
  const id = noteId({
    cardKey: card.key,
    ref,
  })

  // A card moved in keeps the notes its old Hydra harvested, under the same ids.
  if (card.notes?.some(held => held.id === id)) {
    return 0
  }

  const decision = decideNote({
    state: writer.state,
    ref: card.id,
    note,
    meta: {
      at,
      actor: 'harvest',
      id,
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
}: {
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

    appended += codexTitle({
      writer,
      cardId: id,
      path,
      at,
    })

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
    const {
      agent,
      autoTitle,
      sourceRefs,
      settings: held,
    } = writer.state.cards[id]!
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
    const session = cardSessionId({ card: writer.state.cards[id]! })
    // The session title the transcript named last before this read.
    let title = tail.reset || !cursors[name]?.pos || autoTitle?.from !== 'session' ? undefined : `${SESSION_TITLE}${autoTitle.text}`

    for (const line of tail.lines) {
      const parsed = readTranscriptRecord({
        record: line.record,
        subagent,
      })

      for (const note of parsed.notes) {
        if (id === '$hydra' && note.kind === 'summary' && /^(compact:|compacted:)/.test(note.ref)) {
          const timestamp = note.at ?? at
          note.operation = writer.state.cards[id]?.compaction?.operations.findLast(operation =>
            operation.session === session
            && operation.startedAt <= timestamp)?.id
        }

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
        observed: parsed.settings,
      })
      const recordedAt = parsed.at === undefined ? undefined : Date.parse(parsed.at)
      // A record without a valid time may predate the latest hook.
      const afterHook = recordedAt !== undefined && recordedAt >= hooked
      const stale = hooked > 0 && !afterHook

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

    if (changed) {
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
    const saved = structuredClone(cursors)
    writer.afterCommit({
      run: () => writeCursors({
        dir: writer.dir,
        cursors: saved,
      }),
    })
  }

  return appended
}
