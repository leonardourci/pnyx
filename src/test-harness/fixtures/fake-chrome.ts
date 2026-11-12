import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { KEYCHAIN_FLAGS } from '#test-harness/chrome-keychain.ts'

// Starts a stand-in named like Chrome's binary, which prints the arguments it received, the way a
// test would start the real browser.
export async function assertChromeOffKeychain() {
  const binary = join(
    mkdtempSync(join(
      tmpdir(),
      'chrome-',
    )),
    'Google Chrome',
  )
  writeFileSync(
    binary,
    '#!/bin/sh\nprintf "%s\\n" "$@"\n',
    { mode: 0o755 },
  )
  const { stdout } = await promisify(execFile)(
    binary,
    [
      '--headless=new',
      'about:blank',
    ],
  )
  const args = stdout.trim().split('\n')
  assert.deepEqual(
    KEYCHAIN_FLAGS.filter(flag => !args.includes(flag)),
    [],
    `Chrome started with ${args.join(' ')}`,
  )
}
