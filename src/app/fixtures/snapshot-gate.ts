import assert from 'node:assert/strict'
import fs, { writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { getEnvironmentData } from 'node:worker_threads'

const GATE_TIMEOUT_MS = 20_000
const gate = getEnvironmentData('snapshot-test-gate')

if (gate) {
  assert.ok(typeof gate === 'object' && 'buffer' in gate && 'ready' in gate)
  assert.ok(gate.buffer instanceof SharedArrayBuffer && typeof gate.ready === 'string')
  const {
    buffer,
    ready,
  } = gate

  const wait = () => {
    writeFileSync(
      ready,
      '',
    )

    if (Atomics.wait(
      new Int32Array(buffer),
      0,
      0,
      GATE_TIMEOUT_MS,
    ) === 'timed-out') {
      throw new Error('Snapshot test gate was not released')
    }
  }

  if ('beforePublish' in gate && gate.beforePublish) {
    const rename = fs.renameSync

    // eslint-disable-next-line pnyx/object-params -- Node owns renameSync's signature.
    fs.renameSync = (...args: Parameters<typeof fs.renameSync>) => {
      wait()
      rename(...args)
    }

    syncBuiltinESMExports()
  } else {
    wait()
  }
}
