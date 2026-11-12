import type { HydraEvent } from '#app/model.ts'
import type { ThreadEntry, ThreadPage } from './transcripts-read.ts'

interface ItemChanges<Value> {
  upsert: Value[]
  remove: string[]
}

type Conversation = NonNullable<ThreadPage['conversation']>
type RecordChanges<Value> = Record<string, Value | null>
type ThreadIdentity = Pick<ThreadPage, 'card' | 'session' | 'stream'>

export interface ThreadDelta {
  base: number
  page: Omit<ThreadPage, 'entries' | 'actions' | 'conversation'>
  entries: ItemChanges<ThreadEntry>
  actions: ItemChanges<HydraEvent> | null
  conversation: {
    through: number
    entries: ItemChanges<ThreadEntry>
    folds: RecordChanges<Conversation['folds'][string]>
    timings: RecordChanges<Conversation['timings'][string]>
    trailing: RecordChanges<ThreadEntry[]>
  } | null
}

// Unsorted, so every browser builds the same list; threadDelta sends a full page when it differs.
function applyItems<Value extends { id: string }>({
  before,
  changes,
}: {
  before: Value[]
  changes: ItemChanges<Value>
}): Value[] {
  if (!changes.upsert.length && !changes.remove.length) {
    return before
  }

  const removed = new Set(changes.remove)
  const entries = new Map(before.filter(entry => !removed.has(entry.id)).map(entry => [
    entry.id,
    entry,
  ]))

  for (const entry of changes.upsert) {
    entries.set(
      entry.id,
      entry,
    )
  }

  return [...entries.values()]
}

function changedItems<Value extends { id: string }>({
  before,
  after,
}: {
  before: Value[]
  after: Value[]
}): ItemChanges<Value> | undefined {
  const saved = new Map(before.map(entry => [
    entry.id,
    entry,
  ]))
  const current = new Set(after.map(entry => entry.id))
  const changes = {
    upsert: after.filter(entry => JSON.stringify(entry) !== JSON.stringify(saved.get(entry.id))),
    remove: before.filter(entry => !current.has(entry.id)).map(entry => entry.id),
  }
  const applied = applyItems({
    before,
    changes,
  })
  const sameOrder = applied.length === after.length && applied.every((
    entry,
    index,
  ) => entry.id === after[index].id)

  return sameOrder ? changes : undefined
}

function changedRecord<Value>({
  before,
  after,
}: {
  before: Record<string, Value>
  after: Record<string, Value>
}): RecordChanges<Value> {
  const changes = new Map<string, Value | null>()

  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(
      after,
      key,
    )) {
      changes.set(
        key,
        null,
      )
    }
  }

  for (const [
    key,
    value,
  ] of Object.entries(after)) {
    if (JSON.stringify(value) !== JSON.stringify(before[key])) {
      changes.set(
        key,
        value,
      )
    }
  }

  return Object.fromEntries(changes)
}

function applyRecord<Value>({
  before,
  changes,
}: {
  before: Record<string, Value>
  changes: RecordChanges<Value>
}): Record<string, Value> {
  if (!Object.keys(changes).length) {
    return before
  }

  const result = new Map(Object.entries(before))

  for (const [
    key,
    value,
  ] of Object.entries(changes)) {
    if (value === null) {
      result.delete(key)
    } else {
      result.set(
        key,
        value,
      )
    }
  }

  return Object.fromEntries(result)
}

function sameThread({
  before,
  page,
}: {
  before: ThreadIdentity
  page: ThreadIdentity
}) {
  return before.card === page.card && before.session === page.session
    && before.stream === page.stream
}

export function threadDelta({
  before,
  after,
}: {
  before: ThreadPage | undefined
  after: ThreadPage
}): ThreadDelta | undefined {
  if (!before?.stream || before.version === undefined || !sameThread({
    before,
    page: after,
  })) {
    return undefined
  }

  const {
    entries,
    actions,
    conversation,
    ...page
  } = after
  const changed = changedItems({
    before: before.entries,
    after: entries,
  })
  const changedActions = actions && changedItems({
    before: before.actions ?? [],
    after: actions,
  })
  const changedConversation = conversation && changedItems({
    before: before.conversation?.entries ?? [],
    after: conversation.entries,
  })
  const actionsLost = actions !== undefined && !changedActions
  const conversationLost = conversation !== undefined && !changedConversation

  if (!changed || actionsLost || conversationLost) {
    return undefined
  }

  return {
    base: before.version,
    page,
    entries: changed,
    actions: changedActions ?? null,
    conversation: conversation && changedConversation ? {
      through: conversation.through,
      entries: changedConversation,
      folds: changedRecord({
        before: before.conversation?.folds ?? {},
        after: conversation.folds,
      }),
      timings: changedRecord({
        before: before.conversation?.timings ?? {},
        after: conversation.timings,
      }),
      trailing: changedRecord({
        before: before.conversation?.trailing ?? {},
        after: conversation.trailing,
      }),
    } : null,
  }
}

export function receivedThread({
  before,
  latest,
}: {
  before: ThreadPage | null
  latest: ThreadPage
}): ThreadPage {
  if (!before || !sameThread({
    before,
    page: latest,
  })) {
    return latest
  }

  return (before.version ?? 0) > (latest.version ?? 0) ? before : latest
}

export function applyThreadDelta({
  before,
  delta,
}: {
  before: ThreadPage | null
  delta: ThreadDelta
}): ThreadPage | null {
  if (!before || !sameThread({
    before,
    page: delta.page,
  })) {
    return null
  }

  const alreadyApplied = before.version !== undefined && delta.page.version !== undefined
    && before.version >= delta.page.version

  if (alreadyApplied) {
    return before
  }

  const continuesBase = before.version === delta.base && delta.page.version === delta.base + 1

  if (!continuesBase) {
    return null
  }

  const page: ThreadPage = {
    ...delta.page,
    entries: applyItems({
      before: before.entries,
      changes: delta.entries,
    }),
  }

  if (delta.actions) {
    page.actions = applyItems({
      before: before.actions ?? [],
      changes: delta.actions,
    })
  }

  if (delta.conversation) {
    const old = before.conversation
    page.conversation = {
      through: delta.conversation.through,
      entries: applyItems({
        before: old?.entries ?? [],
        changes: delta.conversation.entries,
      }),
      folds: applyRecord({
        before: old?.folds ?? {},
        changes: delta.conversation.folds,
      }),
      timings: applyRecord({
        before: old?.timings ?? {},
        changes: delta.conversation.timings,
      }),
      trailing: applyRecord({
        before: old?.trailing ?? {},
        changes: delta.conversation.trailing,
      }),
    }
  }

  return page
}
