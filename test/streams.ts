import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardEvent } from '../src/core/model.ts'

export const STREAMS = join(import.meta.dirname, 'fixtures', 'streams')

export function readStream({ name }: { name: string }): BoardEvent[] {
  const text = readFileSync(join(STREAMS, `${name}.jsonl`), 'utf8')

  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as BoardEvent)
}

// Compares with the checked-in board. UPDATE_GOLDEN=1 rewrites it after an intended change.
export function assertGolden({ name, actual }: { name: string; actual: unknown }): void {
  const path = join(STREAMS, `${name}.expected.json`)

  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`)
  }

  assert.deepEqual(actual, JSON.parse(readFileSync(path, 'utf8')))
}
