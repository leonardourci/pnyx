import type { HydraState } from './model.ts'
import { EVENT_VERSION } from '#store/events.ts'
import { readFileSync, renameSync } from 'node:fs'
import { snapshotPath, writeDurably } from '#store/storage.ts'

// Bumped when the reducer derives cards differently, so an older cache is replayed.
const RULES = 16

interface Snapshot {
  v: typeof EVENT_VERSION
  rules?: number
  offset: number
  state: HydraState
}

export function readSnapshot({ dir }: { dir: string }): Snapshot | null {
  try {
    const snap = JSON.parse(readFileSync(
      snapshotPath({ dir }),
      'utf8',
    )) as Snapshot

    return snap.v === EVENT_VERSION
      && snap.rules === RULES
      && Number.isInteger(snap.offset)
      && snap.state?.v === EVENT_VERSION
      ? snap
      : null
  } catch {
    return null
  }
}

export function writeSnapshot({
  dir,
  state,
  offset,
}: {
  dir: string
  state: HydraState
  offset: number
}): void {
  const tmp = `${snapshotPath({ dir })}.tmp-${process.pid}`
  writeDurably({
    path: tmp,
    data: JSON.stringify({
      v: EVENT_VERSION,
      rules: RULES,
      offset,
      state,
    } satisfies Snapshot),
    flag: 'w',
  })
  renameSync(
    tmp,
    snapshotPath({ dir }),
  )
}
