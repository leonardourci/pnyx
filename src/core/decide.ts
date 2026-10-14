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
} from './model.ts'
import { TERMINAL_FIELDS } from './route.ts'
import { DEFAULT_VIEW, patchView, viewFor } from './view.ts'
import { isStaleLink, isStaleSource, reduce, wouldCycle } from './reducer.ts'

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

export function findCard(state: BoardState, ref: string): Card {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  if (!card) {
    throw new BoardError(`card not found: ${ref}`, 'NOT_FOUND', ['Run `pnyx-axi` to list cards'])
  }

  return card
}

// Generated ids share a namespace with caller-chosen ones, so skip any already used.
function freeId(state: BoardState, seq: number): string {
  let id = `evt_${seq}`

  for (let n = 2; id in state.eventIds; n++) {
    id = `evt_${seq}_${n}`
  }

  return id
}

function base(state: BoardState, meta: Meta, cardId: string) {
  const seq = state.seq + 1

  return {
    v: EVENT_VERSION,
    seq,
    id: meta.id ?? freeId(state, seq),
    at: meta.at,
    actor: meta.actor,
    cardId,
    ...(meta.reason ? { reason: meta.reason } : {}),
  }
}

function strip(card: Card | undefined) {
  if (!card) {
    return undefined
  }

  const content: Partial<Card> = { ...card }
  delete content.revision
  delete content.updatedSeq
  delete content.updatedAt

  return content
}

function decided(state: BoardState, meta: Meta, event: BoardEvent): Decision {
  if (event.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  checkRevision(state.cards[event.cardId], meta.ifRevision)
  const before = strip(state.cards[event.cardId])
  const after = strip(reduce(state, event).cards[event.cardId])

  return before && isDeepStrictEqual(before, after) ? { skipped: 'unchanged' } : { event }
}

function checkRevision(card: Card | undefined, ifRevision: number | undefined): void {
  const revision = card?.revision ?? 0

  if (ifRevision !== undefined && revision !== ifRevision) {
    throw new BoardError(`card ${card?.id ?? '(new)'} is at revision ${revision}, not ${ifRevision}`, 'REVISION_CONFLICT', [
      card ? `Run \`pnyx-axi card ${card.id}\` and retry with the current revision` : 'Use --if-revision 0 for a new card',
    ])
  }
}

function notUndoable(message: string): BoardError {
  return new BoardError(message, 'NOT_UNDOABLE', ['Run `pnyx-axi history` to find an undoable edit'])
}

function invalid(message: string): BoardError {
  return new BoardError(message, 'VALIDATION_ERROR')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(value).filter(k => !allowed.includes(k))

  if (extra.length > 0) {
    throw invalid(`${what}: unknown field ${extra.join(', ')}; allowed: ${allowed.join(', ')}`)
  }
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${what} must be a non-empty string`)
  }

  return value
}

function optionalText(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : text(value, what)
}

function parseAttention(value: unknown): Attention[] {
  if (!Array.isArray(value)) {
    throw invalid('attention must be a list')
  }

  return value.map((item, i) => {
    if (!isRecord(item)) {
      throw invalid(`attention[${i}] must be an object`)
    }

    onlyKeys(item, ['kind', 'key', 'blocking', 'text'], `attention[${i}]`)

    if (item.blocking !== undefined && typeof item.blocking !== 'boolean') {
      throw invalid(`attention[${i}].blocking must be true or false`)
    }

    const note = optionalText(item.text, `attention[${i}].text`)

    return {
      kind: text(item.kind, `attention[${i}].kind`),
      key: text(item.key, `attention[${i}].key`),
      blocking: item.blocking === true,
      ...(note ? { text: note } : {}),
    }
  })
}

function parseSource(value: unknown): SourceRef {
  if (!isRecord(value)) {
    throw invalid('source must be an object')
  }

  onlyKeys(value, ['adapter', 'instanceId', 'objectId', 'generation', 'cursor', 'observedAt'], 'source')
  const { generation } = value

  if (generation !== undefined && !(Number.isInteger(generation) && (generation as number) >= 0)) {
    throw invalid('source.generation must be a non-negative integer')
  }

  const source: SourceRef = { adapter: text(value.adapter, 'source.adapter'), objectId: text(value.objectId, 'source.objectId') }
  const instanceId = optionalText(value.instanceId, 'source.instanceId')
  const cursor = optionalText(value.cursor, 'source.cursor')
  const observedAt = optionalText(value.observedAt, 'source.observedAt')

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

function parseAutoTitle(value: unknown): AutoTitle {
  if (!isRecord(value)) {
    throw invalid('autoTitle must be an object')
  }

  onlyKeys(value, ['from', 'text'], 'autoTitle')

  if (!(AUTO_TITLE_SOURCES as readonly unknown[]).includes(value.from)) {
    throw invalid(`autoTitle.from must be one of ${AUTO_TITLE_SOURCES.join(', ')}`)
  }

  return { from: value.from as AutoTitle['from'], text: text(value.text, 'autoTitle.text') }
}

function parseAgent(value: unknown): AgentRef {
  if (!isRecord(value)) {
    throw invalid('agent must be an object')
  }

  const fields = ['agentId', 'agentType', 'cwd', 'transcriptPath'] as const
  onlyKeys(value, ['provider', 'sessionId', ...fields], 'agent')
  const agent: AgentRef = { provider: text(value.provider, 'agent.provider'), sessionId: text(value.sessionId, 'agent.sessionId') }

  for (const field of fields) {
    const v = optionalText(value[field], `agent.${field}`)

    if (v) {
      agent[field] = v
    }
  }

  return agent
}

// Merges pushed settings into the card's current ones: a string sets a setting and
// null removes it. Returns the card's whole settings after the push, so the event
// replays and undoes on its own.
function mergeSettings(current: AgentSettings | undefined, value: unknown): AgentSettings | null {
  if (!isRecord(value)) {
    throw invalid('settings must be an object')
  }

  const merged = { ...current }

  for (const [name, v] of Object.entries(value)) {
    if (!/^[a-z][A-Za-z]{0,31}$/.test(name)) {
      throw invalid(`settings.${name}: a setting name is a camelCase word`)
    }

    if (v === null) {
      delete merged[name]
    } else if (typeof v === 'string' && v.trim() !== '' && v.length <= 200) {
      merged[name] = v
    } else {
      throw invalid(`settings.${name} must be a string of up to 200 characters, or null to remove it`)
    }
  }

  return Object.keys(merged).length ? merged : null
}

function parseTerminal(value: unknown): TerminalFacts {
  if (!isRecord(value)) {
    throw invalid('terminal must be an object')
  }

  onlyKeys(value, Object.keys(TERMINAL_FIELDS), 'terminal')

  for (const [field, v] of Object.entries(value)) {
    if (typeof v !== 'string' || !TERMINAL_FIELDS[field as keyof TerminalFacts].test(v)) {
      throw invalid(`terminal.${field} has an unsupported value`)
    }
  }

  return value as TerminalFacts
}

// The key a hook session's observation (key `<harness>:<session>`) goes to: its own
// once it has a card, else the card it joined while that card's agent is still this
// session (a superseded session reports to its own card), else the one card whose
// source assigned the session's working folder, such as the Firstmate task running
// there. A card that already holds a session passes to a new session only in the
// card's own Paseo terminal (after /clear, /new or a respawn the source recorded);
// a session in another or an unknown terminal keeps its own card and never takes
// over the task's agent, terminal or reply route. A card launched in another Paseo
// terminal than the session's is not its task. When several cards remain, the one
// launched in the session's own terminal wins; otherwise they stay ambiguous and
// the session keeps its own card.
export function joinedKey(
  state: BoardState,
  key: string,
  folder: string | undefined,
  terminal?: TerminalFacts,
): string {
  if (key in state.keys) {
    return key
  }

  const colon = key.indexOf(':')
  const sessionId = key.slice(colon + 1)
  const joined = Object.values(state.cards).find(c => c.sourceRefs.some(r =>
    r.adapter === 'hooks' && r.instanceId === key.slice(0, colon) && r.objectId === sessionId))

  if (joined) {
    return !joined.agent || joined.agent.sessionId === sessionId ? joined.key : key
  }

  if (!folder) {
    return key
  }

  const session = terminal?.paseoTerminal
  const ownTerminal = (c: Card) => !!session && c.terminal?.paseoTerminal === session
  const matches = Object.values(state.cards).filter(c => c.folder === folder
    && (ownTerminal(c) || (!c.agent && (!session || !c.terminal?.paseoTerminal))))
  const own = matches.filter(ownTerminal)

  return own.length === 1 ? own[0]!.key : matches.length === 1 ? matches[0]!.key : key
}

// Upserts the card with this key. `input` is the untrusted card JSON; `parent`
// names the parent card by id or key, and null clears it.
export function decidePush(state: BoardState, key: string, input: unknown, meta: Meta): Decision {
  text(key, 'key')

  if (!isRecord(input)) {
    throw invalid('card must be a JSON object')
  }

  onlyKeys(input, ['title', 'autoTitle', 'workspace', 'tags', 'parent', 'activity', 'agent', 'settings', 'terminal', 'folder', 'attention', 'source'], 'card')

  const cardId = state.keys[key] ?? `c${state.seq + 1}`
  const fields: PushFields = {}
  const title = optionalText(input.title, 'title')
  const workspace = optionalText(input.workspace, 'workspace')
  const activity = optionalText(input.activity, 'activity')
  const folder = input.folder === null ? null : optionalText(input.folder, 'folder')

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
      throw invalid('folder must be an absolute path')
    }

    fields.folder = folder
  }

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      throw invalid('tags must be a list of strings')
    }

    fields.tags = [...new Set(input.tags.map((t, i) => text(t, `tags[${i}]`)))]
  }

  if (input.autoTitle !== undefined) {
    fields.autoTitle = parseAutoTitle(input.autoTitle)
  }

  if (input.agent !== undefined) {
    fields.agent = parseAgent(input.agent)
  }

  if (input.settings !== undefined) {
    fields.settings = mergeSettings(state.cards[cardId]?.settings, input.settings)
  }

  if (input.terminal !== undefined) {
    fields.terminal = parseTerminal(input.terminal)
  }

  if (input.attention !== undefined) {
    fields.attention = parseAttention(input.attention)
  }

  if (input.parent === null) {
    fields.parentId = null
  } else if (input.parent !== undefined) {
    const parent = findCard(state, text(input.parent, 'parent'))

    if (wouldCycle(state.cards, cardId, parent.id)) {
      throw invalid(`parent ${parent.id} would make a cycle`)
    }

    fields.parentId = parent.id
  }

  const source = input.source === undefined ? undefined : parseSource(input.source)
  const card = state.cards[cardId]

  if (source && isStaleSource(card, source)) {
    return { skipped: 'stale' }
  }

  let before: PushFields | undefined

  if (card) {
    const changed = Object.entries(fields)
      .filter(([field, value]) => !isDeepStrictEqual(pushedValue(card, field), value))
    before = Object.fromEntries(
      changed.map(([field]) => [field, pushedValue(card, field)]),
    ) as PushFields
  }

  return decided(state, meta, {
    ...base(state, meta, cardId),
    type: 'card.pushed',
    data: { key, ...fields, ...(source ? { source } : {}), ...(before ? { before } : {}) },
  })
}

// The card's value for a push field, null when absent. An auto title counts as absent.
function pushedValue(card: Card, field: string): unknown {
  if (field === 'title' && !card.titleSet) {
    return null
  }

  return (card as unknown as Record<string, unknown>)[field] ?? null
}

function checkColumn(state: BoardState, column: Column | null): void {
  if (column?.startsWith('custom:') && !viewFor(state).customColumns.some(c => c.id === column)) {
    throw invalid('unknown custom column')
  }
}

// column null returns the card to automatic placement.
export function decideMove(
  state: BoardState,
  ref: string,
  column: Column | null,
  meta: Meta,
): Decision {
  const card = findCard(state, ref)
  checkColumn(state, column)

  return decided(state, meta, {
    ...base(state, meta, card.id),
    type: 'card.moved',
    data: { before: card.manualColumn ?? null, after: column },
  })
}

// Builds a link from CLI-style input, filling kind and number from a GitHub pull
// request URL when they are not given.
export function parseLink(input: {
  url: string
  kind?: string
  number?: string
  title?: string
  state?: string
  checkedAt?: string
}): Link {
  let url: URL

  try {
    url = new URL(input.url)
  } catch {
    throw invalid(`not a URL: ${input.url}`)
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid('link URL must be http or https')
  }

  const pr = /^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(url.pathname)
  const isGitHubPr = url.hostname === 'github.com' && pr !== null
  const kind = input.kind ?? (isGitHubPr ? 'github_pr' : 'url')

  if (!(LINK_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`kind must be one of ${LINK_KINDS.join(', ')}`)
  }

  if (input.state !== undefined && !(LINK_STATES as readonly string[]).includes(input.state)) {
    throw invalid(`state must be one of ${LINK_STATES.join(', ')}`)
  }

  const number = input.number ?? (isGitHubPr ? pr[1] : undefined)

  if (number !== undefined && !/^\d+$/.test(number)) {
    throw invalid('number must be a positive integer')
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
  state: BoardState,
  ref: string,
  url: string,
  link: Link | null,
  meta: Meta,
): Decision {
  const card = findCard(state, ref)
  const current = card.links.find(l => l.url === url)

  if (!link && !current) {
    return { skipped: 'unchanged' }
  }

  const after = link ? { ...current, ...link } : null

  if (after && isStaleLink(current, after)) {
    return { skipped: 'stale' }
  }

  return decided(state, meta, {
    ...base(state, meta, card.id),
    type: 'card.linked',
    data: { url, before: current ?? null, after },
  })
}

// source: the adapter observing this outcome. An observed outcome changes or
// clears only through the same source; a person may replace one hooks observed.
export function decideOutcome(
  state: BoardState,
  ref: string,
  outcome: Outcome | null,
  meta: Meta,
  source?: string,
): Decision {
  const card = findCard(state, ref)
  const observed = card.outcome?.source

  if (observed && source !== observed && !(source === undefined && observed === 'hooks')) {
    throw new BoardError(`card ${card.id}'s outcome comes from ${observed} and cannot be changed here`, 'SOURCE_OWNED', [
      `Run \`pnyx-axi move ${card.id} <column>\` to pin the card instead`,
    ])
  }

  return decided(state, meta, {
    ...base(state, meta, card.id),
    type: 'card.outcome',
    data: {
      before: card.outcome ?? null,
      after: outcome && source ? { ...outcome, source } : outcome,
      card: { title: card.title, workspace: card.workspace, tags: card.tags, links: card.links },
    },
  })
}

// Records one receipt of a reply. A receipt that repeats the reply's current state
// appends nothing.
export function decideReply(state: BoardState, ref: string, data: RepliedEvent['data'], meta: Meta): Decision {
  const card = findCard(state, ref)

  return decided(state, meta, { ...base(state, meta, card.id), type: 'card.replied', data })
}

// The event id of a harvested note: the same card and source record always give
// the same id, so a note is appended once however often its source is read.
export function noteId(cardKey: string, ref: string): string {
  return `note_${createHash('sha256').update(`${cardKey}\n${ref}`)
    .digest('hex')
    .slice(0, 20)}`
}

// Records one harvested note. meta.id is the note's stable id, so the same source
// record harvested again is a duplicate and appends nothing.
export function decideNote(
  state: BoardState,
  ref: string,
  note: Note,
  meta: Meta & { id: string },
): Decision {
  const card = findCard(state, ref)

  if (!(NOTE_KINDS as readonly string[]).includes(note.kind)) {
    throw invalid(`note kind must be one of ${NOTE_KINDS.join(', ')}`)
  }

  const data: Note = { kind: note.kind, source: text(note.source, 'note source'), text: text(note.text, 'note text') }

  if (note.at) {
    data.at = note.at
  }

  return decided(state, meta, { ...base(state, meta, card.id), type: 'card.noted', data })
}

function currentValue(card: Card, target: Exclude<BoardEvent, { type: 'board.view' }>): unknown {
  if (target.type === 'card.pushed') {
    return Object.fromEntries(
      Object.keys(target.data.before ?? {}).map(field => [field, pushedValue(card, field)]),
    )
  }

  if (target.type === 'card.moved') {
    return card.manualColumn ?? null
  }

  if (target.type === 'card.linked') {
    return card.links.find(l => l.url === target.data.url) ?? null
  }

  return card.outcome ?? null
}

function afterValue(target: BoardEvent): unknown {
  if (target.type === 'card.replied' || target.type === 'card.noted') {
    return null
  }

  if (target.type !== 'card.pushed') {
    return target.data.after
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
export function decideUndo(state: BoardState, target: BoardEvent, meta: Meta): Decision {
  if (target.type === 'board.view') {
    if (
      state.undone[target.id]
      || !isDeepStrictEqual(viewFor(state), viewFor({ ...state, view: target.data.after }))
    ) {
      throw new BoardError('preferences changed since this event', 'CONFLICT')
    }

    if (meta.ifRevision !== undefined && meta.ifRevision !== (state.viewRevision ?? 0)) {
      throw new BoardError('view preferences changed', 'REVISION_CONFLICT')
    }

    const after = patchView({ ...state, view: DEFAULT_VIEW }, target.data.before)

    return { event: { ...base(state, meta, '$board'), type: 'board.view', undoes: target.id, data: { before: viewFor(state), after } } }
  }

  if (target.type === 'card.replied') {
    throw notUndoable(`${target.id} records a reply, which cannot be unsent`)
  }

  if (target.type === 'card.noted') {
    throw notUndoable(`${target.id} records a note harvested from ${target.data.source} and cannot be undone`)
  }

  if (target.type === 'card.pushed' && target.data.source) {
    throw notUndoable(`${target.id} records a source observation and cannot be undone`)
  }

  if (target.type === 'card.pushed' && !target.data.before) {
    throw notUndoable(`${target.id} created card ${target.cardId} and cannot be undone`)
  }

  const after = target.type === 'card.outcome' && !target.undoes && target.data.after?.source
  const before = target.type === 'card.outcome' && target.data.before?.source
  const observedBy = after || (before && (before !== 'hooks' || target.actor.startsWith('hook:')) && before)

  if (observedBy) {
    throw notUndoable(`${target.id} records an outcome observed by ${observedBy} and cannot be undone`)
  }

  if (target.type === 'card.linked' && target.data.after?.state === 'merged') {
    throw notUndoable(`${target.id} records a merge, which cannot be undone`)
  }

  // Each undo can itself be undone, so follow the chain to the latest one.
  const chain: string[] = []

  for (let by = state.undone[target.id]; by; by = state.undone[by]) {
    chain.push(by)
  }

  const latest = chain.at(-1)

  if (latest) {
    const redone = chain.length % 2 === 0
    throw new BoardError(`${target.id} was already ${redone ? 'redone' : 'undone'} by ${latest}`, 'CONFLICT', [
      `Run \`pnyx-axi undo ${latest}\` to ${redone ? 'undo it again' : 'redo it'}`,
    ])
  }

  const card = findCard(state, target.cardId)
  checkRevision(card, meta.ifRevision)

  if (!isDeepStrictEqual(currentValue(card, target), afterValue(target))) {
    throw new BoardError(`${target.id} no longer matches card ${card.id}: it changed since`, 'CONFLICT', [
      `Run \`pnyx-axi history --card ${card.id}\` to see the later change`,
    ])
  }

  const head = { ...base(state, meta, card.id), undoes: target.id }

  if (target.type === 'card.pushed') {
    const before = target.data.before!
    const data = { key: card.key, ...before, before: afterValue(target) as PushFields }

    return decided(state, meta, { ...head, type: 'card.pushed', data })
  }

  if (target.type === 'card.moved') {
    checkColumn(state, target.data.before)

    return decided(state, meta, { ...head, type: 'card.moved', data: { before: target.data.after, after: target.data.before } })
  }

  if (target.type === 'card.linked') {
    const data = { url: target.data.url, before: target.data.after, after: target.data.before }

    return decided(state, meta, { ...head, type: 'card.linked', data })
  }

  return decided(state, meta, {
    ...head,
    type: 'card.outcome',
    data: {
      before: target.data.after,
      after: target.data.before,
      card: { title: card.title, workspace: card.workspace, tags: card.tags, links: card.links },
    },
  })
}

export function decideView(state: BoardState, patch: unknown, meta: Meta): Decision {
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  if (meta.ifRevision !== undefined && meta.ifRevision !== (state.viewRevision ?? 0)) {
    throw new BoardError('view preferences changed; reload and retry', 'REVISION_CONFLICT')
  }

  const before = viewFor(state), after = patchView(state, patch)

  if (isDeepStrictEqual(before, after)) {
    return { skipped: 'unchanged' }
  }

  return { event: { ...base(state, meta, '$board'), type: 'board.view', data: { before, after } } }
}
