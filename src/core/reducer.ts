import {
  EVENT_VERSION,
  type BoardEvent,
  type BoardState,
  type Card,
  type Column,
  type Link,
  type SourceRef,
} from './model.ts'

export function emptyBoard(): BoardState {
  return { v: EVENT_VERSION, seq: 0, cards: {}, keys: {}, eventIds: {}, undone: {} }
}

// Placement rules, highest precedence first: a manual move, a blocking source
// request, linked pull requests, other attention or a recorded outcome, then ongoing work.
export function columnFor(card: Card): Column {
  if (card.manualColumn) {
    return card.manualColumn
  }

  if (card.attention.some(a => a.blocking)) {
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

  if (card.attention.length > 0) {
    return 'needs_you'
  }

  if (card.outcome) {
    return card.outcome.state === 'failed' && !card.outcome.closed ? 'needs_you' : 'done'
  }

  return 'workers_on_it'
}

function sameSource(a: SourceRef, b: SourceRef): boolean {
  return a.adapter === b.adapter && a.instanceId === b.instanceId && a.objectId === b.objectId
}

// True when the card already holds a newer observation of the same source object:
// a higher generation, or the same generation observed later.
export function isStaleSource(card: Card | undefined, source: SourceRef): boolean {
  const known = card?.sourceRefs.find(r => sameSource(r, source))

  if (!known) {
    return false
  }

  const knownGen = known.generation ?? 0
  const gen = source.generation ?? 0

  if (gen !== knownGen) {
    return gen < knownGen
  }

  // ISO-8601 UTC timestamps compare correctly as strings.
  return known.observedAt !== undefined && source.observedAt !== undefined && source.observedAt < known.observedAt
}

export function isStaleLink(current: Link | undefined, next: Link): boolean {
  return current?.checkedAt !== undefined && next.checkedAt !== undefined && next.checkedAt < current.checkedAt
}

export function wouldCycle(cards: Record<string, Card>, cardId: string, parentId: string): boolean {
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
function apply(state: BoardState, event: BoardEvent): boolean {
  if (event.seq <= state.seq || event.id in state.eventIds) {
    return false
  }

  state.seq = event.seq
  state.eventIds[event.id] = event.seq

  if (event.type === 'board.view') {
    state.view = structuredClone(event.data.after)
    state.viewRevision = (state.viewRevision ?? 0) + 1

    if (event.undoes) {
      state.undone[event.undoes] = event.id
    }

    return true
  }

  let card = state.cards[event.cardId]

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
      if (isStaleSource(card, source)) {
        return false
      }

      card.sourceRefs = [...card.sourceRefs.filter(r => !sameSource(r, source)), source]
    }

    const { parentId, activity, ...rest } = fields
    Object.assign(card, rest)

    if (activity === null) {
      delete card.activity
    } else if (activity !== undefined) {
      card.activity = activity
    }

    if (parentId === null) {
      delete card.parentId
    } else if (parentId !== undefined && !wouldCycle(state.cards, card.id, parentId)) {
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

      if (after && !event.undoes && isStaleLink(current, after)) {
        return false
      }

      const others = card.links.filter(l => l.url !== url)
      card.links = after ? (current ? card.links.map(l => (l.url === url ? after : l)) : [...others, after]) : others
    } else if (event.type === 'card.replied') {
      const reply = { id: event.data.reply, state: event.data.state }
      const replies = card.replies ?? []
      card.replies = replies.some(r => r.id === reply.id) ? replies.map(r => (r.id === reply.id ? reply : r)) : [...replies, reply]
    } else if (event.type === 'card.noted') {
      const { kind, source, at } = event.data
      card.notes = [...(card.notes ?? []), { id: event.id, kind, source, ...(at ? { at } : {}) }]
    } else {
      if (event.data.after) {
        card.outcome = event.data.after
      } else {
        delete card.outcome
      }
    }
  }

  if (event.undoes) {
    state.undone[event.undoes] = event.id
  }

  card.column = columnFor(card)
  card.revision += 1

  if (event.type === 'card.noted') {
    return true
  }

  card.updatedSeq = event.seq
  card.updatedAt = event.at

  return true
}

// Pure: returns a new state and leaves the input untouched.
export function replay(state: BoardState, events: Iterable<BoardEvent>): BoardState {
  const next = structuredClone(state)

  for (const event of events) {
    apply(next, event)
  }

  return next
}

export function reduce(state: BoardState, event: BoardEvent): BoardState {
  return replay(state, [event])
}
