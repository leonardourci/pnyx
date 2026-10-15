import {
  AUTO_TITLE_SOURCES,
  EVENT_VERSION,
  SESSION_TITLE,
  type AutoTitle,
  type BoardEvent,
  type BoardState,
  type Card,
  type Column,
  type Link,
  type SourceRef,
} from './model.ts'
import { applyAttachment, observeSession, sessionId } from './tasks.ts'
import { applyHydra, refreshTasks } from './hydra.ts'
import { requestId } from './answer.ts'

export function emptyBoard(): BoardState {
  return { v: EVENT_VERSION, seq: 0, cards: {}, keys: {}, eventIds: {}, undone: {} }
}

// Placement rules, highest precedence first: a manual move, a blocking source
// request, linked pull requests, other attention or a recorded outcome, then ongoing work.
export function columnFor({ card }: { card: Card }): Column {
  if (card.manualColumn) {
    return card.manualColumn
  }

  // A request answered from the board waits on the session, not on anyone.
  const open = card.attention.filter(a => !a.answered)

  if (open.some(a => a.blocking)) {
    return 'needs_you'
  }

  const prs = card.links.filter(l => l.kind === 'github_pr')

  if (prs.some(l => l.state === 'open')) {
    return 'review'
  }

  if (prs.length > 0 && prs.every(l => l.state === 'merged')) {
    return 'done'
  }

  if (prs.some(l => l.state === 'closed')) {
    return 'needs_you'
  }

  if (open.some(a => a.kind !== 'idle')) {
    return 'needs_you'
  }

  if (card.outcome) {
    return card.outcome.state === 'failed' && !card.outcome.closed ? 'needs_you' : 'done'
  }

  return 'workers_on_it'
}

// Keeps the best auto title seen: a better source replaces a worse one, a later
// session title or folder replaces an earlier one, and the first prompt stays. It
// becomes the title only while no push has set one.
function offerTitle({ card, next }: { card: Card; next: AutoTitle }): void {
  const current = card.autoTitle

  if (current) {
    const rank = AUTO_TITLE_SOURCES.indexOf(next.from) - AUTO_TITLE_SOURCES.indexOf(current.from)

    if (rank > 0 || (rank === 0 && next.from === 'prompt')) {
      return
    }
  }

  card.autoTitle = next

  if (!card.titleSet) {
    card.title = next.text
  }
}

function sameSource({ a, b }: { a: SourceRef; b: SourceRef }): boolean {
  return a.adapter === b.adapter && a.instanceId === b.instanceId && a.objectId === b.objectId
}

// True when the card already holds a newer observation of the same source object:
// a higher generation, or the same generation observed later.
export function isStaleSource({ card, source }: {
  card: Card | undefined
  source: SourceRef
}): boolean {
  const known = card?.sourceRefs.find(r => sameSource({ a: r, b: source }))

  if (!known) {
    return false
  }

  const knownGen = known.generation ?? 0
  const gen = source.generation ?? 0

  if (gen !== knownGen) {
    return gen < knownGen
  }

  // ISO-8601 UTC timestamps compare correctly as strings.
  return known.observedAt !== undefined
    && source.observedAt !== undefined
    && source.observedAt < known.observedAt
}

export function isStaleLink({ current, next }: { current: Link | undefined; next: Link }): boolean {
  return current?.checkedAt !== undefined
    && next.checkedAt !== undefined
    && next.checkedAt < current.checkedAt
}

export function wouldCycle({ cards, cardId, parentId }: {
  cards: Record<string, Card>
  cardId: string
  parentId: string
}): boolean {
  const seen = new Set<string>()

  for (let p: string | undefined = parentId; p !== undefined; p = cards[p]?.parentId) {
    if (p === cardId || seen.has(p)) {
      return true
    }

    seen.add(p)
  }

  return false
}

// Applies one event to a state the caller owns. Returns false when the event is
// ignored: already applied, out of sequence, for an unknown card, or stale.
function apply({ state, event }: { state: BoardState; event: BoardEvent }): boolean {
  if (event.seq <= state.seq || event.id in state.eventIds) {
    return false
  }

  state.seq = event.seq
  state.eventIds[event.id] = event.seq

  if (applyHydra({ state, event })) {
    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    return true
  }

  if (event.type === 'chat.message') {
    return true
  }

  if (event.type === 'board.view') {
    state.view = structuredClone(event.data.after)
    state.viewRevision = (state.viewRevision ?? 0) + 1

    for (const placement of event.data.placements ?? []) {
      const placed = state.cards[placement.cardId]

      if (!placed) {
        continue
      }

      if (placement.after) {
        placed.manualColumn = placement.after
      } else {
        delete placed.manualColumn
      }

      placed.column = columnFor({ card: placed })
      placed.revision += 1
      placed.updatedSeq = event.seq
      placed.updatedAt = event.at
    }

    refreshTasks({ state })

    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    return true
  }

  let card = state.cards[event.cardId]

  if (event.type === 'task.session') {
    applyAttachment({ state, event })

    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    const touched = [event.cardId, event.data.before, event.data.after]

    for (const id of touched) {
      const task = id && state.cards[id]

      if (task) {
        task.column = columnFor({ card: task })
      }
    }

    refreshTasks({ state, ids: touched })

    if (card && event.data.before !== card.id) {
      card.revision++
      card.updatedSeq = event.seq
      card.updatedAt = event.at
    }

    return true
  }

  if (event.type === 'card.pushed') {
    const { key, source, ...fields } = event.data
    delete fields.before

    if (!card) {
      if (key in state.keys) {
        return false
      }

      card = {
        id: event.cardId,
        key,
        title: key,
        workspace: 'unassigned',
        tags: [],
        attention: [],
        links: [],
        sourceRefs: [],
        ...(fields.agent && (!source || source.adapter === 'hooks') ? { automaticTask: true } : {}),
        column: 'workers_on_it',
        revision: 0,
        createdSeq: event.seq,
        updatedSeq: event.seq,
        updatedAt: event.at,
      }
      state.cards[card.id] = card
      state.keys[key] = card.id
    }

    if (source) {
      if (isStaleSource({ card, source })) {
        return false
      }

      card.sourceRefs = [...card.sourceRefs.filter(r => !sameSource({ a: r, b: source })), source]
    }

    const { parentId, activity, settings, folder, autoTitle, ...rest } = fields
    Object.assign(card, rest)

    if (settings === null) {
      delete card.settings
    } else if (settings !== undefined) {
      card.settings = settings
    }

    if (rest.title === null) {
      delete card.titleSet
      card.title = card.autoTitle?.text ?? key
    } else if (rest.title !== undefined) {
      card.titleSet = true
    }

    if (autoTitle) {
      offerTitle({ card, next: autoTitle })
    }

    if (folder === null) {
      delete card.folder
    } else if (folder !== undefined) {
      card.folder = folder
    }

    if (activity === null) {
      delete card.activity
    } else if (activity !== undefined) {
      card.activity = activity
    }

    if (source?.adapter === 'hooks' && typeof activity === 'string') {
      card.sessionActivity = activity
    }

    if (parentId === null) {
      delete card.parentId
    } else if (parentId !== undefined && !wouldCycle({
      cards: state.cards,
      cardId: card.id,
      parentId,
    })) {
      card.parentId = parentId
    }
  } else {
    if (!card) {
      return false
    }

    if (event.type === 'card.moved') {
      if (event.data.after) {
        card.manualColumn = event.data.after
      } else {
        delete card.manualColumn
      }
    } else if (event.type === 'card.linked') {
      const { url, after } = event.data
      const current = card.links.find(l => l.url === url)

      if (after && !event.undoes && isStaleLink({ current, next: after })) {
        return false
      }

      const others = card.links.filter(l => l.url !== url)
      card.links = after
        ? (current ? card.links.map(l => (l.url === url ? after : l)) : [...others, after])
        : others
    } else if (event.type === 'card.replied') {
      const reply = { id: event.data.reply, state: event.data.state }
      const replies = card.replies ?? []
      card.replies = replies.some(r => r.id === reply.id)
        ? replies.map(r => (r.id === reply.id ? reply : r))
        : [...replies, reply]
      const answers = event.data.answers

      // A task shows its session's requests, which hooks read back from the
      // session's own card, so the answer is marked on all three.
      if (answers && event.data.state === 'delivered') {
        const session = card.sessionIds?.[0] ? state.sessions?.[card.sessionIds[0]] : undefined
        const origin = session && state.cards[session.originCardId]

        for (const holder of [card, session, origin]) {
          if (holder) {
            holder.attention = holder.attention
              .map(a => (requestId({ request: a }) === answers ? { ...a, answered: reply.id } : a))
          }
        }
      }
    } else if (event.type === 'card.noted') {
      const { kind, source, at, text } = event.data
      card.notes = [...(card.notes ?? []), { id: event.id, kind, source, ...(at ? { at } : {}) }]

      if (kind === 'context' && text.startsWith(SESSION_TITLE)) {
        offerTitle({ card, next: { from: 'session', text: text.slice(SESSION_TITLE.length) } })
      }
    } else if (event.type === 'card.outcome') {
      if (event.data.after) {
        card.outcome = event.data.after
      } else {
        delete card.outcome
      }

      const before = event.data.before, after = event.data.after
      const changed = before?.state !== after?.state || before?.note !== after?.note
        || before?.closed !== after?.closed || before?.source !== after?.source
      const manual = !after?.source && before?.source !== 'firstmate'
        && !(!after && before?.source === 'hooks')

      const undone = event.undoes ? card.statusLog?.findIndex(d => d.id === event.undoes) ?? -1 : -1

      if (undone >= 0) {
        if (card.status?.id === event.undoes) {
          const previous = card.statusLog![undone - 1]

          if (previous) {
            card.status = previous
          } else {
            delete card.status
          }
        }
      } else if (card.tracking && changed && manual) {
        const declaration = {
          id: event.id,
          at: event.at,
          actor: event.actor,
          state: !event.data.after ? 'paused' as const
            : event.data.after.state === 'failed' && !event.data.after.closed
              ? 'blocked' as const : 'done' as const,
          note: event.data.after?.note ?? 'Task outcome updated',
        }
        card.status = declaration
        card.statusLog = [...(card.statusLog ?? []), declaration]
      }
    }
  }

  if (event.undoes) {
    state.undone[event.undoes] = event.id
  }

  observeSession({ state, card, event })
  card.column = columnFor({ card })
  const task = card.agent && state.sessions?.[sessionId({ agent: card.agent })]?.taskId
  const worker = task && task !== card.id ? state.cards[task] : undefined

  if (worker) {
    worker.column = columnFor({ card: worker })
  }

  refreshTasks({ state, ids: [card.id, worker?.id] })

  card.revision += 1

  if (event.type === 'card.noted') {
    return true
  }

  card.updatedSeq = event.seq
  card.updatedAt = event.at

  return true
}

// Pure: returns a new state and leaves the input untouched.
export function replay({ state, events }: {
  state: BoardState
  events: Iterable<BoardEvent>
}): BoardState {
  const next = structuredClone(state)

  for (const event of events) {
    apply({ state: next, event })
  }

  return next
}

export function reduce({ state, event }: { state: BoardState; event: BoardEvent }): BoardState {
  return replay({ state, events: [event] })
}
