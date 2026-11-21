import type { HydraSummary } from './server-hydras.ts'
import type { PageState } from './page-state.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { PageSettings } from '#settings/model.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import type { SocketCursor } from './socket-history.ts'

export interface HydraPage {
  state: PageState
  queue: HydraQueue
}

export interface HomePage {
  hydras: HydraSummary[]
  settings: {
    settings: PageSettings
    revision: number
  }
  upgrade: UpgradeStatus | null
  scopes: Record<string, HydraPage>
}

export interface PageChanges {
  set: Record<string, unknown>
  remove: string[]
  nested: Record<string, PageChanges>
}

export type HomeMessage =
  | {
    type: 'home.snapshot'
    cursor: SocketCursor
    home: HomePage
  }
  | {
    type: 'home.delta'
    cursor: SocketCursor
    changes: PageChanges
  }
  | {
    type: 'home.ready'
    cursor: SocketCursor
  }

const object = ({ value }: { value: unknown }): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function pageChanges({
  before,
  after,
}: {
  before: object
  after: object
}): PageChanges | undefined {
  const previous = before as Record<string, unknown>
  const current = after as Record<string, unknown>
  const set: Record<string, unknown> = Object.create(null)
  const remove = Object.keys(previous).filter(key => !Object.hasOwn(
    current,
    key,
  ))
  const nested: Record<string, PageChanges> = Object.create(null)

  for (const [
    key,
    value,
  ] of Object.entries(current)) {
    const owned = Object.hasOwn(
      previous,
      key,
    )
    const old = owned ? previous[key] : undefined

    if (owned && Object.is(
      old,
      value,
    )) {
      continue
    }

    if (object({ value: old }) && object({ value })) {
      const changes = pageChanges({
        before: old as Record<string, unknown>,
        after: value as Record<string, unknown>,
      })

      if (changes) {
        nested[key] = changes
      }
    } else if (JSON.stringify(old) !== JSON.stringify(value)) {
      set[key] = value
    }
  }

  if (!Object.keys(set).length && !remove.length && !Object.keys(nested).length) {
    return undefined
  }

  return {
    set,
    remove,
    nested,
  }
}

export function applyPageChanges<Value extends object>({
  before,
  changes,
}: {
  before: Value
  changes: PageChanges
}): Value {
  const next: Record<string, unknown> = {
    ...before,
    ...changes.set,
  }

  for (const key of changes.remove) {
    delete next[key]
  }

  for (const [
    key,
    patch,
  ] of Object.entries(changes.nested)) {
    const old = next[key]

    if (!Object.hasOwn(
      next,
      key,
    ) || !object({ value: old })) {
      throw new Error(`socket patch has no object at ${key}`)
    }

    next[key] = applyPageChanges({
      before: old as Record<string, unknown>,
      changes: patch,
    })
  }

  return next as Value
}
