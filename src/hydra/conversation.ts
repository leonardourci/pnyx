import type { HydraEvent } from '#app/model.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { HydraMessage } from './model.ts'
import type { ThreadEntry, ThreadPage } from './transcripts-read.ts'
import { hydraMessages, leadingTask, ownMessage, quietReply, type TurnTiming } from './chat-messages.ts'
import { relevantUpdate, type TaskUpdate } from '#tasks/updates.ts'
import { threadEntryOrder } from './thread-order.ts'

export interface TaskActions {
  task: string
  title: string
  updates: TaskUpdate[]
}

export interface TurnActions {
  tasks: TaskActions[]
  notes: ThreadEntry[]
}

const spoken = ({ entry }: { entry: ThreadEntry }) => entry.text.trim() !== '' && !quietReply({ entry })

// The owner's messages among the entries, in the order they were sent.
export function ownerMessagesInSendOrder({
  messages,
  entries,
}: {
  messages: HydraMessage[]
  entries: ThreadEntry[]
}) {
  const sent = new Map(messages.map((
    message,
    index,
  ) => [
    message.id,
    index,
  ]))

  return entries.flatMap(entry => {
    const index = sent.get(entry.reference ?? '')

    return ownMessage({ entry }) && index !== undefined ? [
      {
        entry,
        index,
      },
    ] : []
  })
    .toSorted((
      a,
      b,
    ) => a.index - b.index)
}

// Claude Code records a message that joins a running turn as an attachment, not a user message, so it keeps its send time.
// An owner message no later than one sent before it is late, so a tie still shows in send order.
export function lateOwnerMessages({
  messages,
  entries,
}: {
  messages: HydraMessage[]
  entries: ThreadEntry[]
}) {
  const owner = ownerMessagesInSendOrder({
    messages,
    entries,
  })
  const late = new Map<ThreadEntry, {
    at: string
    index: number
  }>()
  let floor = ''

  for (const {
    entry,
    index,
  } of owner) {
    if (entry.at && entry.at <= floor) {
      late.set(
        entry,
        {
          at: floor,
          index,
        },
      )
    } else if (entry.at) {
      floor = entry.at
    }
  }

  return late
}

// Time order, except that an owner message shows no earlier than the owner messages sent before it.
function conversationOrder({
  messages,
  entries,
}: {
  messages: HydraMessage[]
  entries: ThreadEntry[]
}) {
  const late = lateOwnerMessages({
    messages,
    entries,
  })
  const shownAt = ({ entry }: { entry: ThreadEntry }) => late.get(entry)?.at ?? entry.at

  const order = ({
    first,
    second,
  }: {
    first: ThreadEntry
    second: ThreadEntry
  }) => {
    const before = late.get(first)
    const after = late.get(second)
    const time = (shownAt({ entry: first }) ?? '').localeCompare(shownAt({ entry: second }) ?? '')

    if (time) {
      return time
    }

    // A late message goes after the entries already at the place it takes.
    if (before && !after) {
      return 1
    }

    if (after && !before) {
      return -1
    }

    // Late messages that share a place keep the order they were sent in.
    if (before && after) {
      return before.index - after.index
    }

    return threadEntryOrder({
      first,
      second,
    })
  }

  return {
    shownAt,
    order,
  }
}

export function hydraConversation({
  messages,
  transcript,
  provider,
  actions,
  columns,
  working,
  tools,
  thinking,
  titles = {},
  oldest,
  currentTurn,
  receipts = true,
}: {
  messages: HydraMessage[]
  transcript: ThreadEntry[]
  provider?: string
  // Only a Hydra Pnyx runs reports when it took a message.
  receipts?: boolean
  actions: HydraEvent[]
  columns: HydraColumn[]
  working: boolean
  tools: boolean
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

  const merged = hydraMessages({
    messages,
    transcript: inputs,
    provider,
    boundaries: true,
    waiting: working ? 'Hydra is in the middle of a step' : undefined,
    receipts,
  })
  const {
    shownAt,
    order,
  } = conversationOrder({
    messages,
    entries: merged,
  })
  const reconciled = merged.filter(entry => {
    const at = shownAt({ entry })

    return oldest === undefined || at === undefined || at >= oldest
  }).sort((
    first,
    second,
  ) => order({
    first,
    second,
  }))
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

  const foldBefore = ({
    entry,
    progress,
  }: {
    entry: ThreadEntry
    progress: ThreadEntry[]
  }) => {
    if (progress.length) {
      folds.set(
        entry.id,
        {
          tasks: [],
          notes: progress,
        },
      )
    }
  }

  // Progress after a turn's last shown entry: the running turn's calls so far, or a turn that ended without a reply.
  const trailing = new Map<string, ThreadEntry[]>()
  const timings = new Map<string, TurnTiming>()

  for (const [
    index,
    turn,
  ] of turns.entries()) {
    const ownerStarted = turn.input !== undefined && !turn.input.hidden
    const current = index === turns.length - 1 && working
    const texts = turn.entries.filter(entry => entry.kind === 'message'
      && entry.role.startsWith('assistant') && !entry.hidden)
    const replies = texts.filter(entry => spoken({ entry }))
    const last = replies.at(-1)
    const completed = replies.filter(entry => entry.final === true)
    const visible = new Set(completed)

    if (last) {
      visible.add(last)
    }

    if (ownerStarted) {
      entries.push(turn.input!)
    }

    let progress: ThreadEntry[] = []

    for (const entry of turn.entries) {
      if (entry.role === 'Pnyx') {
        foldBefore({
          entry,
          progress,
        })
        entries.push({
          ...entry,
          hidden: false,
        })
        progress = []
        continue
      }

      const trace = tools && entry.kind === 'tool' || thinking && entry.kind === 'thinking'

      if (entry.hidden || !trace && !replies.includes(entry)) {
        continue
      }

      if (!visible.has(entry)) {
        progress.push(entry)
        continue
      }

      foldBefore({
        entry,
        progress,
      })
      progress = []
      entries.push(entry)
    }

    const anchor = entries.at(-1)

    if (progress.length && anchor) {
      trailing.set(
        anchor.id,
        [
          ...trailing.get(anchor.id) ?? [],
          ...progress,
        ],
      )
    }

    const start = turn.input && shownAt({ entry: turn.input })

    if (ownerStarted && !current && start && last?.at) {
      timings.set(
        last.id,
        {
          start,
          end: last.at,
          reply: last.text,
          task: leadingTask({ entry: last }),
          latest: false,
        },
      )
    }

    if (!ownerStarted) {
      continue
    }

    const next = turns[index + 1]?.input
    const nextAt = next && shownAt({ entry: next })
    const tasks = new Map<string, TaskUpdate[]>()

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

    if (tasks.size) {
      const anchor = last?.id ?? turn.input!.id
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
          notes: folds.get(anchor)?.notes ?? [],
        },
      )
    }
  }

  entries.sort((
    first,
    second,
  ) => order({
    first,
    second,
  }))

  const latest = [...timings.values()].at(-1)

  if (latest) {
    latest.latest = true
  }

  return {
    entries,
    timings,
    folds,
    trailing,
  }
}
