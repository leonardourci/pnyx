// Turns a requested change into the event to append, validated against the current
// board. Pure: the caller supplies the time and actor.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  AUTO_TITLE_SOURCES,
  BoardError,
  EVENT_VERSION,
  LINK_KINDS,
  LINK_STATES,
  NOTE_KINDS,
  type AgentRef,
  type AgentSettings,
  type Attention,
  type AutoTitle,
  type BoardEvent,
  type BoardState,
  type Card,
  type Column,
  type Link,
  type Note,
  type Outcome,
  type PushFields,
  type RepliedEvent,
  type SourceRef,
  type TerminalFacts,
  type ViewEvent,
  type ViewPreferences,
} from './model.ts'
import { TERMINAL_FIELDS } from './route.ts'
import { DEFAULT_VIEW, patchView, viewFor } from './view.ts'
import { isStaleLink, isStaleSource, reduce, wouldCycle } from './reducer.ts'
import { columnCards, findSession, rankOf } from './tasks.ts'
import { boardConfig, fallbackColumn, hydraEvent } from './hydra.ts'

export interface Meta {
  at: string
  actor: string
  // Caller-chosen event id; repeating it is a no-op.
  id?: string
  // Expected card revision; 0 for a card that does not exist yet.
  ifRevision?: number
  reason?: string
}

export type Decision = { event: BoardEvent } | { skipped: 'unchanged' | 'stale' | 'duplicate' }

export function findCard({ state, ref }: { state: BoardState; ref: string }): Card {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  if (!card) {
    throw new BoardError({ message: `card not found: ${ref}`, code: 'NOT_FOUND', help: ['Run `pnyx-axi` to list cards'] })
  }

  return card
}

// Generated ids share a namespace with caller-chosen ones, so skip any already used.
function freeId({ state, seq }: { state: BoardState; seq: number }): string {
  let id = `evt_${seq}`

  for (let n = 2; id in state.eventIds; n++) {
    id = `evt_${seq}_${n}`
  }

  return id
}

function base({ state, meta, cardId }: { state: BoardState; meta: Meta; cardId: string }) {
  const seq = state.seq + 1

  return {
    v: EVENT_VERSION,
    seq,
    id: meta.id ?? freeId({ state, seq }),
    at: meta.at,
    actor: meta.actor,
    cardId,
    ...(meta.reason ? { reason: meta.reason } : {}),
  }
}

function strip({ card }: { card: Card | undefined }) {
  if (!card) {
    return undefined
  }

  const content: Partial<Card> = { ...card }
  delete content.revision
  delete content.updatedSeq
  delete content.updatedAt

  return content
}

function decided({ state, meta, event }: {
  state: BoardState
  meta: Meta
  event: BoardEvent
}): Decision {
  if (event.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  checkRevision({ card: state.cards[event.cardId], ifRevision: meta.ifRevision })
  const before = strip({ card: state.cards[event.cardId] })
  const reduced = reduce({ state, event })
  const after = strip({ card: reduced.cards[event.cardId] })

  return before && isDeepStrictEqual(before, after) && isDeepStrictEqual(state.sessions, reduced.sessions) ? { skipped: 'unchanged' } : { event }
}

function checkRevision({ card, ifRevision }: {
  card: Card | undefined
  ifRevision: number | undefined
}): void {
  const revision = card?.revision ?? 0

  if (ifRevision !== undefined && revision !== ifRevision) {
    throw new BoardError({
      message: `card ${card?.id ?? '(new)'} is at revision ${revision}, not ${ifRevision}`,
      code: 'REVISION_CONFLICT',
      help: [
        card ? `Run \`pnyx-axi card ${card.id}\` and retry with the current revision` : 'Use --if-revision 0 for a new card',
      ],
    })
  }
}

function notUndoable({ message }: { message: string }): BoardError {
  return new BoardError({ message, code: 'NOT_UNDOABLE', help: ['Run `pnyx-axi history` to find an undoable edit'] })
}

function invalid({ message }: { message: string }): BoardError {
  return new BoardError({ message, code: 'VALIDATION_ERROR' })
}

function asRecord({ value }: { value: unknown }): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function onlyKeys({ value, allowed, what }: {
  value: Record<string, unknown>
  allowed: string[]
  what: string
}): void {
  const extra = Object.keys(value).filter(k => !allowed.includes(k))

  if (extra.length > 0) {
    throw invalid({ message: `${what}: unknown field ${extra.join(', ')}; allowed: ${allowed.join(', ')}` })
  }
}

function text({ value, what }: { value: unknown; what: string }): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid({ message: `${what} must be a non-empty string` })
  }

  return value
}

function optionalText({ value, what }: { value: unknown; what: string }): string | undefined {
  return value === undefined ? undefined : text({ value, what })
}

function parseAttention({ value }: { value: unknown }): Attention[] {
  if (!Array.isArray(value)) {
    throw invalid({ message: 'attention must be a list' })
  }

  return value.map((rawItem, i) => {
    const item = asRecord({ value: rawItem })

    if (!item) {
      throw invalid({ message: `attention[${i}] must be an object` })
    }

    onlyKeys({ value: item, allowed: ['kind', 'key', 'blocking', 'text'], what: `attention[${i}]` })

    if (item.blocking !== undefined && typeof item.blocking !== 'boolean') {
      throw invalid({ message: `attention[${i}].blocking must be true or false` })
    }

    const note = optionalText({ value: item.text, what: `attention[${i}].text` })

    return {
      kind: text({ value: item.kind, what: `attention[${i}].kind` }),
      key: text({ value: item.key, what: `attention[${i}].key` }),
      blocking: item.blocking === true,
      ...(note ? { text: note } : {}),
    }
  })
}

function parseSource({ value: rawValue }: { value: unknown }): SourceRef {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'source must be an object' })
  }

  onlyKeys({ value, allowed: ['adapter', 'instanceId', 'objectId', 'generation', 'cursor', 'observedAt'], what: 'source' })
  const { generation } = value

  if (generation !== undefined && !(Number.isInteger(generation) && (generation as number) >= 0)) {
    throw invalid({ message: 'source.generation must be a non-negative integer' })
  }

  const source: SourceRef = { adapter: text({ value: value.adapter, what: 'source.adapter' }), objectId: text({ value: value.objectId, what: 'source.objectId' }) }
  const instanceId = optionalText({ value: value.instanceId, what: 'source.instanceId' })
  const cursor = optionalText({ value: value.cursor, what: 'source.cursor' })
  const observedAt = optionalText({ value: value.observedAt, what: 'source.observedAt' })

  if (instanceId) {
    source.instanceId = instanceId
  }

  if (generation !== undefined) {
    source.generation = generation as number
  }

  if (cursor) {
    source.cursor = cursor
  }

  if (observedAt) {
    source.observedAt = observedAt
  }

  return source
}

function parseAutoTitle({ value: rawValue }: { value: unknown }): AutoTitle {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'autoTitle must be an object' })
  }

  onlyKeys({ value, allowed: ['from', 'text'], what: 'autoTitle' })

  if (!(AUTO_TITLE_SOURCES as readonly unknown[]).includes(value.from)) {
    throw invalid({ message: `autoTitle.from must be one of ${AUTO_TITLE_SOURCES.join(', ')}` })
  }

  return { from: value.from as AutoTitle['from'], text: text({ value: value.text, what: 'autoTitle.text' }) }
}

function parseAgent({ value: rawValue }: { value: unknown }): AgentRef {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'agent must be an object' })
  }

  const fields = ['agentId', 'agentType', 'cwd', 'transcriptPath'] as const
  onlyKeys({ value, allowed: ['provider', 'sessionId', ...fields], what: 'agent' })
  const agent: AgentRef = { provider: text({ value: value.provider, what: 'agent.provider' }), sessionId: text({ value: value.sessionId, what: 'agent.sessionId' }) }

  for (const field of fields) {
    const v = optionalText({ value: value[field], what: `agent.${field}` })

    if (v) {
      agent[field] = v
    }
  }

  return agent
}

// Merges pushed settings into the card's current ones: a string sets a setting and
// null removes it. Returns the card's whole settings after the push, so the event
// replays and undoes on its own.
function mergeSettings({ current, value: rawValue }: {
  current: AgentSettings | undefined
  value: unknown
}): AgentSettings | null {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'settings must be an object' })
  }

  const merged = { ...current }

  for (const [name, v] of Object.entries(value)) {
    if (!/^[a-z][A-Za-z]{0,31}$/.test(name)) {
      throw invalid({ message: `settings.${name}: a setting name is a camelCase word` })
    }

    if (v === null) {
      delete merged[name]
    } else if (typeof v === 'string' && v.trim() !== '' && v.length <= 200) {
      merged[name] = v
    } else {
      throw invalid({ message: `settings.${name} must be a string of up to 200 characters, or null to remove it` })
    }
  }

  return Object.keys(merged).length ? merged : null
}

function parseTerminal({ value: rawValue }: { value: unknown }): TerminalFacts {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'terminal must be an object' })
  }

  onlyKeys({ value, allowed: Object.keys(TERMINAL_FIELDS), what: 'terminal' })

  for (const [field, v] of Object.entries(value)) {
    if (typeof v !== 'string' || !TERMINAL_FIELDS[field as keyof TerminalFacts].test(v)) {
      throw invalid({ message: `terminal.${field} has an unsupported value` })
    }
  }

  return value as TerminalFacts
}

// Explicit attachments survive folder changes; Firstmate joins also honor its recorded terminal.
export function joinedKey({ state, key, folder, terminal, probed = false }: {
  state: BoardState
  key: string
  folder: string | undefined
  terminal?: TerminalFacts
  probed?: boolean
}): string {
  const recorded = Object.values(state.sessions ?? {}).find(s => s.sourceRefs.some(r =>
    r.adapter === 'hooks' && `${r.instanceId}:${r.objectId}` === key))

  if (recorded) {
    const task = recorded.taskId ? state.cards[recorded.taskId] : undefined
    const managed = task?.sourceRefs.some(r => r.adapter === 'firstmate')

    const matchesTerminal = !task?.terminal?.paseoTerminal
      || task.terminal.paseoTerminal === terminal?.paseoTerminal

    return task && (!managed || matchesTerminal)
      ? task.key : key
  }

  if (key in state.keys) {
    return key
  }

  const colon = key.indexOf(':')
  const sessionId = key.slice(colon + 1)
  const joined = Object.values(state.cards).find(c => c.sourceRefs.some(r =>
    r.adapter === 'hooks' && r.instanceId === key.slice(0, colon) && r.objectId === sessionId))

  const session = terminal?.paseoTerminal

  if (joined) {
    return (!joined.agent || joined.agent.sessionId === sessionId)
      && (!joined.terminal?.paseoTerminal || joined.terminal.paseoTerminal === session)
      ? joined.key
      : key
  }

  if (!folder || (probed && !terminal?.tty)) {
    return key
  }

  const tty = terminal?.tty
  const ownTerminal = ({ card: c }: { card: Card }) =>
    !!session && c.terminal?.paseoTerminal === session
  const succeeds = ({ card: c }: { card: Card }) => !!tty
    && (c.activity === 'ended' || !c.terminal?.tty || c.terminal.tty === tty)
  const matches = Object.values(state.cards).filter(c => c.folder === folder
    && (c.agent
      ? ownTerminal({ card: c }) && succeeds({ card: c })
      : !c.terminal?.paseoTerminal || ownTerminal({ card: c })))
  const own = matches.filter(card => ownTerminal({ card }))

  return own.length === 1 ? own[0]!.key : matches.length === 1 ? matches[0]!.key : key
}

export function decideSession({ state, ref, task, meta }: {
  state: BoardState
  ref: string
  task: string | null
  meta: Meta
}): Decision {
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  const session = findSession({ state, ref })
  const target = task === null ? null : findCard({ state, ref: task })
  const current = session.taskId ? state.cards[session.taskId] : state.cards[session.originCardId]
  const card = target ?? current!
  checkRevision({ card, ifRevision: meta.ifRevision })

  if (target?.sessionIds?.some(id => id !== session.id)) {
    throw new BoardError({ message: `task ${target.id} already has an attached agent; detach it first`, code: 'SESSION_CONFLICT' })
  }

  if (target && state.board?.hydra.session === session.id) {
    throw new BoardError({ message: 'Hydra cannot also be a task worker', code: 'CONFLICT' })
  }

  if (target && !session.terminal?.tty) {
    throw new BoardError({ message: 'A background session has no interactive terminal and cannot be attached to a task', code: 'NO_TERMINAL' })
  }

  if (session.taskId === (target?.id ?? null)) {
    return { skipped: 'unchanged' }
  }

  return {
    event: {
      ...base({ state, meta, cardId: card.id }),
      type: 'task.session',
      data: { session: session.id, before: session.taskId, after: target?.id ?? null },
    },
  }
}

// Upserts the card with this key. `input` is the untrusted card JSON; `parent`
// names the parent card by id or key, and null clears it.
export function decidePush({ state, key, input: rawInput, meta }: {
  state: BoardState
  key: string
  input: unknown
  meta: Meta
}): Decision {
  text({ value: key, what: 'key' })

  const input = asRecord({ value: rawInput })

  if (!input) {
    throw invalid({ message: 'card must be a JSON object' })
  }

  onlyKeys({ value: input, allowed: ['title', 'autoTitle', 'workspace', 'tags', 'parent', 'activity', 'agent', 'settings', 'terminal', 'folder', 'attention', 'source'], what: 'card' })

  const cardId = state.keys[key] ?? `c${state.seq + 1}`
  const fields: PushFields = {}
  const title = optionalText({ value: input.title, what: 'title' })
  const workspace = optionalText({ value: input.workspace, what: 'workspace' })
  const activity = optionalText({ value: input.activity, what: 'activity' })
  const folder = input.folder === null ? null : optionalText({ value: input.folder, what: 'folder' })

  if (title) {
    fields.title = title
  }

  if (workspace) {
    fields.workspace = workspace
  }

  if (activity) {
    fields.activity = activity
  }

  if (folder === null) {
    fields.folder = null
  } else if (folder) {
    if (!folder.startsWith('/')) {
      throw invalid({ message: 'folder must be an absolute path' })
    }

    fields.folder = folder
  }

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      throw invalid({ message: 'tags must be a list of strings' })
    }

    fields.tags = [...new Set(input.tags.map((t, i) => text({ value: t, what: `tags[${i}]` })))]
  }

  if (input.autoTitle !== undefined) {
    fields.autoTitle = parseAutoTitle({ value: input.autoTitle })
  }

  if (input.agent !== undefined) {
    fields.agent = parseAgent({ value: input.agent })
  }

  if (input.settings !== undefined) {
    fields.settings = mergeSettings({
      current: state.cards[cardId]?.settings,
      value: input.settings,
    })
  }

  if (input.terminal !== undefined) {
    fields.terminal = parseTerminal({ value: input.terminal })
  }

  if (input.attention !== undefined) {
    fields.attention = parseAttention({ value: input.attention })
  }

  if (input.parent === null) {
    fields.parentId = null
  } else if (input.parent !== undefined) {
    const parent = findCard({ state, ref: text({ value: input.parent, what: 'parent' }) })

    if (wouldCycle({ cards: state.cards, cardId, parentId: parent.id })) {
      throw invalid({ message: `parent ${parent.id} would make a cycle` })
    }

    const hasChildren = Object.values(state.cards).some(c => c.parentId === cardId)

    const declared = state.configured || state.cards[cardId]?.tracking || parent.tracking
    const hookSession = asRecord({ value: input.source })?.adapter === 'hooks' && input.agent

    if (declared && !hookSession && (parent.parentId || hasChildren)) {
      throw invalid({ message: 'subtasks have one level; a subtask cannot have children' })
    }

    fields.parentId = parent.id
  }

  const source = input.source === undefined ? undefined : parseSource({ value: input.source })
  const card = state.cards[cardId]

  if (source && isStaleSource({ card, source })) {
    return { skipped: 'stale' }
  }

  let before: PushFields | undefined

  if (card) {
    const changed = Object.entries(fields)
      .filter(([field, value]) => !isDeepStrictEqual(pushedValue({ card, field }), value))
    before = Object.fromEntries(
      changed.map(([field]) => [field, pushedValue({ card, field })]),
    ) as PushFields
  }

  return decided({
    state,
    meta,
    event: {
      ...base({ state, meta, cardId }),
      type: 'card.pushed',
      data: { key, ...fields, ...(source ? { source } : {}), ...(before ? { before } : {}) },
    },
  })
}

// The card's value for a push field, null when absent. An auto title counts as absent.
function pushedValue({ card, field }: { card: Card; field: string }): unknown {
  if (field === 'title' && !card.titleSet) {
    return null
  }

  return (card as unknown as Record<string, unknown>)[field] ?? null
}

function checkColumn({ state, column }: { state: BoardState; column: Column | null }): void {
  if (column && !boardConfig({ state }).columns.some(c => c.id === column)) {
    throw invalid({ message: `unknown board column: ${column}` })
  }
}

// Places the card in column just above the card `before`, or at the end of the
// column without one. The rank falls between its new neighbours'.
export function decideMove(
  { state, ref, column, before, meta }: {
    state: BoardState
    ref: string
    column: Column
    before?: string
    meta: Meta
  },
): Decision {
  const card = findCard({ state, ref })
  checkColumn({ state, column })
  const others = columnCards({ state, column }).filter(c => c.id !== card.id)
  const above = before === undefined ? undefined : findCard({ state, ref: before }).id
  const at = above === undefined ? others.length : others.findIndex(c => c.id === above)

  if (at < 0) {
    throw invalid({ message: `card ${before} is not in column ${column}` })
  }

  const next = others[at], previous = others[at - 1]
  const rank = next && previous ? (rankOf({ card: previous }) + rankOf({ card: next })) / 2
    : next ? rankOf({ card: next }) - 1
      : previous ? rankOf({ card: previous }) + 1 : rankOf({ card })

  return decided({
    state,
    meta,
    event: {
      ...base({ state, meta, cardId: card.id }),
      type: 'card.moved',
      data: { before: card.column, after: column, rank, beforeRank: rankOf({ card }) },
    },
  })
}

// Builds a link from CLI-style input, filling kind and number from a GitHub pull
// request URL when they are not given.
export function parseLink({ input }: {
  input: {
    url: string
    kind?: string
    number?: string
    title?: string
    state?: string
    checkedAt?: string
  }
}): Link {
  let url: URL

  try {
    url = new URL(input.url)
  } catch {
    throw invalid({ message: `not a URL: ${input.url}` })
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid({ message: 'link URL must be http or https' })
  }

  const pr = /^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(url.pathname)
  const isGitHubPr = url.hostname === 'github.com' && pr !== null
  const kind = input.kind ?? (isGitHubPr ? 'github_pr' : 'url')

  if (!(LINK_KINDS as readonly string[]).includes(kind)) {
    throw invalid({ message: `kind must be one of ${LINK_KINDS.join(', ')}` })
  }

  if (input.state !== undefined && !(LINK_STATES as readonly string[]).includes(input.state)) {
    throw invalid({ message: `state must be one of ${LINK_STATES.join(', ')}` })
  }

  const number = input.number ?? (isGitHubPr ? pr[1] : undefined)

  if (number !== undefined && !/^\d+$/.test(number)) {
    throw invalid({ message: 'number must be a positive integer' })
  }

  const link: Link = { kind: kind as Link['kind'], url: input.url }

  if (number !== undefined) {
    link.number = Number(number)
  }

  if (input.title) {
    link.title = input.title
  }

  if (input.state) {
    link.state = input.state as Link['state']
  }

  if (input.checkedAt) {
    link.checkedAt = input.checkedAt
  }

  return link
}

// Adds or updates a link (merged over the existing one with the same URL), or
// removes it when link is null.
export function decideLink(
  { state, ref, url, link, meta }: {
    state: BoardState
    ref: string
    url: string
    link: Link | null
    meta: Meta
  },
): Decision {
  const card = findCard({ state, ref })
  const current = card.links.find(l => l.url === url)

  if (!link && !current) {
    return { skipped: 'unchanged' }
  }

  const after = link ? { ...current, ...link } : null

  if (after && isStaleLink({ current, next: after })) {
    return { skipped: 'stale' }
  }

  return decided({
    state,
    meta,
    event: {
      ...base({ state, meta, cardId: card.id }),
      type: 'card.linked',
      data: { url, before: current ?? null, after },
    },
  })
}

// source: the adapter observing this outcome. An observed outcome changes or
// clears only through the same source; a person may replace one hooks observed.
export function decideOutcome(
  { state, ref, outcome, meta, source }: {
    state: BoardState
    ref: string
    outcome: Outcome | null
    meta: Meta
    source?: string
  },
): Decision {
  const card = findCard({ state, ref })
  const observed = card.outcome?.source

  if (observed && source !== observed && !(source === undefined && observed === 'hooks')) {
    throw new BoardError({
      message: `card ${card.id}'s outcome comes from ${observed} and cannot be changed here`,
      code: 'SOURCE_OWNED',
      help: [
        `Run \`pnyx-axi move ${card.id} <column>\` to pin the card instead`,
      ],
    })
  }

  return decided({
    state,
    meta,
    event: {
      ...base({ state, meta, cardId: card.id }),
      type: 'card.outcome',
      data: {
        before: card.outcome ?? null,
        after: outcome && source ? { ...outcome, source } : outcome,
        card: { title: card.title, workspace: card.workspace, tags: card.tags, links: card.links },
      },
    },
  })
}

// Records one receipt of a reply. A receipt that repeats the reply's current state
// appends nothing.
export function decideReply({ state, ref, data, meta }: { state: BoardState; ref: string; data: RepliedEvent['data']; meta: Meta }): Decision {
  const card = findCard({ state, ref })

  return decided({ state, meta, event: { ...base({ state, meta, cardId: card.id }), type: 'card.replied', data } })
}

// The event id of a harvested note: the same card and source record always give
// the same id, so a note is appended once however often its source is read.
export function noteId({ cardKey, ref }: { cardKey: string; ref: string }): string {
  return `note_${createHash('sha256').update(`${cardKey}\n${ref}`)
    .digest('hex')
    .slice(0, 20)}`
}

// Records one harvested note. meta.id is the note's stable id, so the same source
// record harvested again is a duplicate and appends nothing.
export function decideNote(
  { state, ref, note, meta }: {
    state: BoardState
    ref: string
    note: Note
    meta: Meta & {
      id: string
    }
  },
): Decision {
  const card = findCard({ state, ref })

  if (!(NOTE_KINDS as readonly string[]).includes(note.kind)) {
    throw invalid({ message: `note kind must be one of ${NOTE_KINDS.join(', ')}` })
  }

  const data: Note = { kind: note.kind, source: text({ value: note.source, what: 'note source' }), text: text({ value: note.text, what: 'note text' }) }

  if (note.at) {
    data.at = note.at
  }

  return decided({ state, meta, event: { ...base({ state, meta, cardId: card.id }), type: 'card.noted', data } })
}

function currentValue({ card, target }: { card: Card; target: Exclude<BoardEvent, { type: 'board.view' }> }): unknown {
  if (target.type === 'card.pushed') {
    return Object.fromEntries(
      Object.keys(target.data.before ?? {}).map(field => [field, pushedValue({ card, field })]),
    )
  }

  if (target.type === 'card.moved') {
    return { column: card.column, rank: rankOf({ card }) }
  }

  if (target.type === 'card.linked') {
    return card.links.find(l => l.url === target.data.url) ?? null
  }

  return card.outcome ?? null
}

function afterValue({ target }: { target: BoardEvent }): unknown {
  if (target.type === 'card.replied' || target.type === 'card.noted') {
    return null
  }

  if (target.type === 'card.moved') {
    return { column: target.data.after, rank: target.data.rank }
  }

  if (target.type !== 'card.pushed' && 'after' in target.data) {
    return target.data.after
  }

  if (target.type !== 'card.pushed') {
    return null
  }

  const after = target.data as unknown as Record<string, unknown>

  return Object.fromEntries(
    Object.keys(target.data.before ?? {}).map(field => [field, after[field] ?? null]),
  )
}

// Appends the reverse of `target`. Refuses when the field has changed since, so an
// undo never silently overwrites a later edit. Source observations, card creation
// and merges are facts, not edits, and cannot be undone. Only a source makes a push
// an observation: --actor is attribution, so a direct CLI or UI write stays undoable
// whether a person or an agent made it. A sent reply cannot be unsent, and a
// harvested note is a source observation.
export function decideUndo({ state, target, meta }: {
  state: BoardState
  target: BoardEvent
  meta: Meta
}): Decision {
  if (target.type === 'board.columns') {
    const unchanged = isDeepStrictEqual(boardConfig({ state }).columns, target.data.columns)

    if (!target.data.before || state.undone[target.id] || !unchanged) {
      throw new BoardError({ message: 'columns changed since this event', code: 'CONFLICT' })
    }

    const pins = Object.entries(target.data.placements ?? {})
    const placements = Object.fromEntries(pins.map(([id, pin]) => {
      const card = state.cards[id]

      if (!card || card.column !== pin.after) {
        throw new BoardError({ message: `task ${id} moved after the column edit`, code: 'CONFLICT' })
      }

      return [id, { before: pin.after, after: pin.before }]
    }))
    const decision = hydraEvent({ state, meta, cardId: '$board', change: { type: 'board.columns', data: { columns: target.data.before, before: target.data.columns, placements } } })

    return 'event' in decision ? { event: { ...decision.event, undoes: target.id } } : decision
  }

  if (['board.configured', 'task.created', 'task.declared', 'task.mirrored', 'hydra.message', 'chat.message'].includes(target.type)) {
    throw notUndoable({ message: `${target.id} records durable work history; append a correction instead` })
  }

  if (target.type === 'task.session') {
    const session = findSession({ state, ref: target.data.session })

    if (state.undone[target.id] || session.taskId !== target.data.after) {
      throw new BoardError({ message: 'session attachment changed since this event', code: 'CONFLICT' })
    }

    checkRevision({ card: findCard({ state, ref: target.cardId }), ifRevision: meta.ifRevision })
    const decision = decideSession({
      state, ref: session.id, task: target.data.before, meta: { ...meta, ifRevision: undefined },
    })

    return 'event' in decision ? { event: { ...decision.event, undoes: target.id } } : decision
  }

  if (target.type === 'board.view') {
    if (
      state.undone[target.id]
      || !isDeepStrictEqual(viewFor({
        state,
      }), viewFor({
        state: {
          ...state,
          view: target.data.after,
        },
      }))
    ) {
      throw new BoardError({ message: 'preferences changed since this event', code: 'CONFLICT' })
    }

    if (meta.ifRevision !== undefined && meta.ifRevision !== (state.viewRevision ?? 0)) {
      throw new BoardError({ message: 'view preferences changed', code: 'REVISION_CONFLICT' })
    }

    const after = patchView({ state: { ...state, view: DEFAULT_VIEW }, input: target.data.before })
    const placements = removedColumnPlacements({ state, after })

    // Undoing a column deletion puts its cards back, unless one was placed since.
    for (const p of target.data.placements ?? []) {
      const card = state.cards[p.cardId]

      if (!card || card.column !== p.after) {
        throw new BoardError({ message: `card ${p.cardId} was moved since this event`, code: 'CONFLICT' })
      }

      if (placements.some(q => q.cardId === card.id)) {
        continue
      }

      placements.push({
        cardId: card.id,
        before: p.after,
        after: p.before,
        revision: card.revision,
      })
    }

    return {
      event: {
        ...base({ state, meta, cardId: '$board' }),
        type: 'board.view',
        undoes: target.id,
        data: { before: viewFor({ state }), after, ...(placements.length ? { placements } : {}) },
      },
    }
  }

  if (target.type === 'card.replied') {
    throw notUndoable({ message: `${target.id} records a reply, which cannot be unsent` })
  }

  if (target.type === 'card.noted') {
    throw notUndoable({ message: `${target.id} records a note harvested from ${target.data.source} and cannot be undone` })
  }

  if (target.type === 'card.pushed' && target.data.source) {
    throw notUndoable({ message: `${target.id} records a source observation and cannot be undone` })
  }

  if (target.type === 'card.pushed' && !target.data.before) {
    throw notUndoable({ message: `${target.id} created card ${target.cardId} and cannot be undone` })
  }

  const after = target.type === 'card.outcome' && !target.undoes && target.data.after?.source
  const before = target.type === 'card.outcome' && target.data.before?.source
  const observedBy = after || (before && (before !== 'hooks' || target.actor.startsWith('hook:')) && before)

  if (observedBy) {
    throw notUndoable({ message: `${target.id} records an outcome observed by ${observedBy} and cannot be undone` })
  }

  if (target.type === 'card.linked' && target.data.after?.state === 'merged') {
    throw notUndoable({ message: `${target.id} records a merge, which cannot be undone` })
  }

  // Each undo can itself be undone, so follow the chain to the latest one.
  const chain: string[] = []

  for (let by = state.undone[target.id]; by; by = state.undone[by]) {
    chain.push(by)
  }

  const latest = chain.at(-1)

  if (latest) {
    const redone = chain.length % 2 === 0
    throw new BoardError({
      message: `${target.id} was already ${redone ? 'redone' : 'undone'} by ${latest}`,
      code: 'CONFLICT',
      help: [
        `Run \`pnyx-axi undo ${latest}\` to ${redone ? 'undo it again' : 'redo it'}`,
      ],
    })
  }

  const card = findCard({ state, ref: target.cardId })
  checkRevision({ card, ifRevision: meta.ifRevision })

  if (!isDeepStrictEqual(currentValue({ card, target }), afterValue({ target }))) {
    throw new BoardError({
      message: `${target.id} no longer matches card ${card.id}: it changed since`,
      code: 'CONFLICT',
      help: [
        `Run \`pnyx-axi history --card ${card.id}\` to see the later change`,
      ],
    })
  }

  const head = { ...base({ state, meta, cardId: card.id }), undoes: target.id }

  if (target.type === 'card.pushed') {
    const before = target.data.before!
    const data = { key: card.key, ...before, before: afterValue({ target }) as PushFields }

    return decided({ state, meta, event: { ...head, type: 'card.pushed', data } })
  }

  if (target.type === 'card.moved') {
    checkColumn({ state, column: target.data.before })

    const { before, after, rank, beforeRank } = target.data

    return decided({ state, meta, event: { ...head, type: 'card.moved', data: { before: after, after: before, rank: beforeRank, beforeRank: rank } } })
  }

  if (target.type === 'card.linked') {
    const data = { url: target.data.url, before: target.data.after, after: target.data.before }

    return decided({ state, meta, event: { ...head, type: 'card.linked', data } })
  }

  if (target.type !== 'card.outcome') {
    throw notUndoable({ message: `${target.id} cannot be undone` })
  }

  return decided({
    state,
    meta,
    event: {
      ...head,
      type: 'card.outcome',
      data: {
        before: target.data.after,
        after: target.data.before,
        card: { title: card.title, workspace: card.workspace, tags: card.tags, links: card.links },
      },
    },
  })
}

export function decideView({ state, patch, meta }: {
  state: BoardState
  patch: unknown
  meta: Meta
}): Decision {
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  if (meta.ifRevision !== undefined && meta.ifRevision !== (state.viewRevision ?? 0)) {
    throw new BoardError({ message: 'view preferences changed; reload and retry', code: 'REVISION_CONFLICT' })
  }

  const before = viewFor({ state }), after = patchView({ state, input: patch })

  if (isDeepStrictEqual(before, after)) {
    return { skipped: 'unchanged' }
  }

  const placements = removedColumnPlacements({ state, after })

  return {
    event: {
      ...base({ state, meta, cardId: '$board' }),
      type: 'board.view',
      data: { before, after, ...(placements.length ? { placements } : {}) },
    },
  }
}

// Cards in a deleted legacy view column move to the fallback column; board columns stay.
function removedColumnPlacements({ state, after }: {
  state: BoardState
  after: ViewPreferences
}): NonNullable<ViewEvent['data']['placements']> {
  const kept = new Set<Column>([
    ...after.customColumns.map(c => c.id),
    ...(state.board?.columns.map(c => c.id) ?? []),
  ])
  const columns = boardConfig({ state: { ...state, view: after } }).columns
  const fallback = fallbackColumn({ columns })

  return Object.values(state.cards)
    .filter(c => c.column.startsWith('custom:') && !kept.has(c.column))
    .map(c => ({ cardId: c.id, before: c.column, after: fallback, revision: c.revision }))
}
