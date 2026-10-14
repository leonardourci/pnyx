import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')

function run(...args: string[]): string {
  // Tests never touch the real ~/.pnyx.
  const env = { ...process.env, PNYX_HOME: mkdtempSync(join(tmpdir(), 'pnyx-test-')) }

  return execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
}

test('no arguments prints an empty board summary', () => {
  const out = run()
  assert.match(out, /^board: default$/m)
  assert.match(out, /^ {2}needs_you: 0$/m)
  assert.match(out, /^cards: "none: no cards yet"$/m)
  assert.match(out, /pnyx-axi push --key/)
})

test('--help prints concise help', () => {
  const out = run('--help')
  assert.match(out, /^usage: pnyx-axi/)
  assert.ok(out.split('\n').length < 29)
})

test('update fails with a structured error while unpublished', () => {
  assert.throws(() => run('update'), (error: { status: number; stdout: string }) => {
    assert.equal(error.status, 2)
    assert.match(error.stdout, /^code: VALIDATION_ERROR$/m)

    return true
  })
})
