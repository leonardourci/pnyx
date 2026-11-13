import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { getEnvironmentData } from 'node:worker_threads'

const GATE_TIMEOUT_MS = 20_000
const gate = getEnvironmentData(import.meta.url)

if (gate) {
  assert.ok(typeof gate === 'object' && 'buffer' in gate && 'ready' in gate)
  assert.ok(gate.buffer instanceof SharedArrayBuffer && typeof gate.ready === 'string')
  writeFileSync(
    gate.ready,
    '',
  )

  if (Atomics.wait(
    new Int32Array(gate.buffer),
    0,
    0,
    GATE_TIMEOUT_MS,
  ) === 'timed-out') {
    throw new Error('Oracle fixture gate was not released')
  }
}
