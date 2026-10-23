import type { HydraColumn, HydraEvent, HydraMessage } from '../../../src/core/model.ts'
import type { ThreadEntry, ThreadPage } from '../../../src/thread/read.ts'
import { QUIET_REPLY } from '../../../src/core/hydra.ts'
import { hydraMessages, ownMessage, type TurnTiming } from './chat.ts'
import { relevantUpdate, type TaskUpdate } from '../../../src/core/updates.ts'

export interface TaskActions {
  task: string
  title: string
  updates: TaskUpdate[]
}

export interface TurnActions {
  tasks: TaskActions[]
  notes: ThreadEntry[]
}

export function hydraConversation({
  messages,
  transcript,
  provider,
  actions,
  columns,
  working,
  thinking,
  titles = {},
  oldest,
  currentTurn,
}: {
  messages: HydraMessage[]
  transcript: ThreadEntry[]
  provider?: string
  actions: HydraEvent[]
  columns: HydraColumn[]
  working: boolean
  thinking: boolean
  titles?: Record<string, string>
  oldest?: string
  currentTurn?: ThreadPage['currentTurn']
}) {
  const inputs = [...transcript]

  if (currentTurn && !currentTurn.owner) {
    inputs.unshift({
      id: `turn:${currentTurn.at}`,
      at: currentTurn.at,
      kind: 'message',
      role: 'user',
      text: '',
      hidden: true,
    })
  }

  const reconciled = hydraMessages({
    messages,
    transcript: inputs,
    provider,
    boundaries: true,
  })
    .filter(entry => oldest === undefined || entry.at === undefined || entry.at >= oldest)
    .sort((
      a,
      b,
    ) => (a.at ?? '').localeCompare(b.at ?? ''))
  const turns: {
    input?: ThreadEntry
    entries: ThreadEntry[]
  }[] = [{ entries: [] }]

  for (const entry of reconciled) {
    if (ownMessage({ entry })) {
      turns.push({
        input: entry,
        entries: [],
      })
    } else {
      turns.at(-1)!.entries.push(entry)
    }
  }

  const orderedActions = actions.toSorted((
    a,
    b,
  ) => a.seq - b.seq)
  const entries: ThreadEntry[] = []
  const folds = new Map<string, TurnActions>()
  const timings = new Map<string, TurnTiming>()

  for (const [
    index,
    turn,
  ] of turns.entries()) {
    const ownerStarted = turn.input !== undefined && !turn.input.hidden
    const current = index === turns.length - 1 && working
    const texts = turn.entries.filter(entry => entry.kind === 'message'
      && entry.role.startsWith('assistant') && !entry.hidden)
    const last = texts.at(-1)
    const quiet = last && QUIET_REPLY.startsWith(last.text.trim())
    const visibleReply = last && !quiet && (ownerStarted || !current)

    if (ownerStarted) {
      entries.push(turn.input!)

      if (thinking) {
        entries.push(...turn.entries.filter(entry => entry.kind === 'thinking'))
      }
    }

    if (visibleReply) {
      entries.push(last)

      if (ownerStarted && !current && turn.input?.at && last.at) {
        timings.set(
          last.id,
          {
            start: turn.input.at,
            end: last.at,
            reply: last.text,
            latest: false,
          },
        )
      }
    }

    if (!ownerStarted) {
      continue
    }

    const nextAt = turns[index + 1]?.input?.at
    const tasks = new Map<string, TaskUpdate[]>()
    const start = turn.input!.at

    for (const event of orderedActions) {
      const afterStart = start !== undefined && event.at >= start
      const beforeNext = nextAt === undefined || event.at < nextAt
      const inTurn = afterStart && beforeNext

      if (!inTurn || event.actor !== 'hydra') {
        continue
      }

      const row = relevantUpdate({
        event: {
          id: event.id,
          seq: event.seq,
          at: event.at,
          actor: event.actor,
          type: event.type,
          reason: event.reason,
          details: event.details,
          data: { ...event.data },
          summary: '',
        },
        columns,
      })

      if (!row || row.kind === 'hydra' || row.kind === 'decision') {
        continue
      }

      const updates = tasks.get(event.cardId) ?? []
      updates.push({
        ...row,
        id: event.id,
        at: event.at,
        seq: event.seq,
      })
      tasks.set(
        event.cardId,
        updates,
      )
    }

    const notes = texts.slice(
      0,
      -1,
    ).filter(entry => !QUIET_REPLY.startsWith(entry.text.trim()))

    if (tasks.size || notes.length) {
      const anchor = visibleReply ? last.id : turn.input!.id
      folds.set(
        anchor,
        {
          tasks: [...tasks].map(([
            task,
            updates,
          ]) => ({
            task,
            title: titles[task] ?? task,
            updates,
          })),
          notes,
        },
      )
    }
  }

  const latest = [...timings.values()].at(-1)

  if (latest) {
    latest.latest = true
  }

  return {
    entries,
    timings,
    folds,
  }
}
