import { readTranscriptRecord } from '#workers/transcripts.ts'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { decideNote, noteId } from '#tasks/notes.ts'
import { decidePush } from '#tasks/push.ts'
import { EVENT_VERSION } from '#store/events.ts'
import { SESSION_TITLE, type SourceNote } from '#tasks/model.ts'
import type { AgentSession, SessionEvent } from '#workers/model.ts'
import { cardSessionId, taskForMessage } from '#workers/session-attachments.ts'
import { transcriptEntries, type ThreadEntry } from '#hydra/transcripts-read.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { chatRecordKey } from '#hydra/chat-events.ts'
import { chatRecordId, recordedChats } from '#hydra/chat-records.ts'
import type { ChatEvent } from '#hydra/model.ts'
import type { Writer } from '#app/writer.ts'
import { readTranscript } from '#oracle/index.ts'
import { codexThreadTitle } from '#workers/codex.ts'
import type { FoundSettings } from '#workers/provider.ts'
import { LIVE_HOOK_SETTINGS, observedSettings } from './settings.ts'

const CURSORS = 'harvest.json'

// "<card id>\n<transcript path>" -> how far it was read.
type Cursors = Record<string, {
  identity: string
  pos: number
  conversation?: number
  backfill?: {
    pos: number
    item: number
    end: number
  }
}>
const CONVERSATION_VERSION = 1
const BACKFILL_ENTRIES = 32
const BACKFILL_BYTES = 64 * 1024

function recordChat({
  writer,
  entry,
  session,
  cardId,
  agentId,
  at,
  recorded,
  repair = false,
}: {
  writer: Writer
  entry: ThreadEntry
  session: string
  cardId: string
  agentId: string
  at: string
  recorded: Map<string, ChatEvent>
  repair?: boolean
}) {
  if (entry.kind === 'divider') {
    return
  }

  const messageId = chatRecordId({
    session,
    nativeId: entry.id,
    messageId: entry.messageId,
    part: entry.part,
  })
  const data: ChatEvent['data'] = {
    session,
    nativeId: entry.id,
    block: entry.block,
    final: entry.final,
    messageId: entry.messageId,
    part: entry.part,
    role: entry.role,
    kind: entry.kind,
    hidden: entry.hidden,
    call: entry.call,
    text: entry.text,
  }
  const key = chatRecordKey({ data })
  const known = recorded.get(key)
  const unchanged = known && known.data.text === data.text
    && known.data.block === data.block && known.data.final === data.final
    && (known.data.kind ?? 'message') === data.kind
    && Boolean(known.data.hidden) === Boolean(data.hidden)
    && known.data.call === data.call && known.data.role === data.role

  if (known && (!repair || unchanged)) {
    return
  }

  let id = messageId

  if (known) {
    data.replaces = known.id
    id = noteId({
      cardKey: session,
      ref: `chat-repair:${messageId}:${JSON.stringify(data)}`,
    })
  }

  const event: ChatEvent = {
    v: EVENT_VERSION,
    seq: writer.state.seq + 1,
    id,
    at: entry.at ?? at,
    actor: `session:${session}`,
    cardId,
    agentId,
    type: 'chat.message',
    sessionId: session,
    messageId,
    data,
  }
  writer.append({ event })
  recorded.set(
    key,
    event,
  )
}

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
  const recorded = new Map(recordedChats({ dir: writer.dir }))

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
      const parsed = readTranscriptRecord({
        record: line.record,
        subagent,
      })
      const card = writer.state.cards[id]!
      const session = detached?.session.id ?? cardSessionId({ card })

      if (session && (detached || card.tracking === 'declared' || id === '$hydra')) {
        for (const entry of transcriptEntries({
          parsed,
          offset: line.pos,
          boundaries: id === HYDRA_CARD,
        })) {
          if (id !== HYDRA_CARD && entry.kind !== 'message') {
            continue
          }

          const cardId = detached ? taskForMessage({
            memberships: detached.memberships,
            fallback: detached.task,
            at: entry.at,
          }) : id
          recordChat({
            writer,
            entry,
            session,
            cardId,
            agentId: `${agent!.provider}:${agent!.agentId ?? agent!.sessionId}`,
            at,
            recorded,
          })
        }
      }

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
      conversation: id === HYDRA_CARD
        ? cursors[name]?.conversation
          ?? (tail.reset || !cursors[name] ? CONVERSATION_VERSION : undefined)
        : undefined,
      backfill: cursors[name]?.backfill,
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

export function backfillConversations({
  writer,
  at,
}: {
  writer: Writer
  at: string
}) {
  const cursors = readCursors({ dir: writer.dir })
  const recorded = new Map(recordedChats({ dir: writer.dir }))

  for (const [
    name,
    cursor,
  ] of Object.entries(cursors)) {
    if (!name.startsWith(`${HYDRA_CARD}\n`) || cursor.conversation === CONVERSATION_VERSION) {
      continue
    }

    const path = name.slice(HYDRA_CARD.length + 1)
    const session = Object.values(writer.state.sessions ?? {})
      .find(session => session.agent.transcriptPath === path)

    if (!session) {
      continue
    }

    const progress = cursor.backfill ?? {
      pos: 0,
      item: 0,
      end: cursor.pos,
    }
    const transcript = readTranscript({
      cursor: {
        source: path,
        identity: cursor.identity,
        pos: progress.pos,
      },
      through: progress.end,
      maxBytes: BACKFILL_BYTES,
    })

    const stalled = transcript?.end === progress.pos && progress.pos < progress.end

    if (!transcript || transcript.reset || stalled) {
      continue
    }

    let remaining = BACKFILL_ENTRIES

    for (const line of transcript.lines) {
      const entries = transcriptEntries({
        parsed: readTranscriptRecord({ record: line.record }),
        offset: line.pos,
        boundaries: true,
      })
      const start = line.pos === progress.pos ? progress.item : 0

      for (let item = start; item < entries.length; item++) {
        if (remaining === 0) {
          cursor.backfill = {
            pos: line.pos,
            item,
            end: progress.end,
          }
          writeCursors({
            dir: writer.dir,
            cursors,
          })

          return {
            progressed: true,
          }
        }

        recordChat({
          writer,
          entry: entries[item]!,
          session: session.id,
          cardId: HYDRA_CARD,
          agentId: session.id,
          at,
          recorded,
          repair: true,
        })
        remaining--
      }
    }

    cursor.backfill = {
      pos: transcript.end,
      item: 0,
      end: progress.end,
    }

    if (transcript.end >= progress.end) {
      cursor.conversation = CONVERSATION_VERSION
      delete cursor.backfill
    }

    writeCursors({
      dir: writer.dir,
      cursors,
    })

    return {
      progressed: true,
    }
  }

  return {
    progressed: false,
  }
}
