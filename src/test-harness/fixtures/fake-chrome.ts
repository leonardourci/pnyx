import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { KEYCHAIN_FLAGS } from '#test-harness/chrome-keychain.ts'

// Chrome reads every argument after `--` as a URL, so the flags count only before it.
const CHROME_ARGS = [
  '--headless=new',
  '--',
  'about:blank',
]

// A stand-in named like Chrome's binary, which prints the arguments it received.
function fakeChrome() {
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

  return binary
}

const LAUNCHES = {
  execFile: async ({ binary }: { binary: string }) => (await promisify(execFile)(
    binary,
    CHROME_ARGS,
  )).stdout,
  execFileSync: async ({ binary }: { binary: string }) => execFileSync(
    binary,
    CHROME_ARGS,
    { encoding: 'utf8' },
  ),
  spawnSync: async ({ binary }: { binary: string }) => spawnSync(
    binary,
    CHROME_ARGS,
    { encoding: 'utf8' },
  ).stdout,
  'spawnSync(file, options)': async ({ binary }: { binary: string }) => spawnSync(
    binary,
    { encoding: 'utf8' },
  ).stdout,
}

// Through a shell the command line reaches Chrome as written, so the guard adds nothing.
const SHELL_LAUNCHES = {
  'execFile(command, { shell: true })': async ({ command }: { command: string }) => (await promisify(execFile)(
    command,
    { shell: true },
  )).stdout,
  'spawnSync(command, { shell: true })': async ({ command }: { command: string }) => spawnSync(
    command,
    {
      shell: true,
      encoding: 'utf8',
    },
  ).stdout,
}

// Registers one test per way a test starts the real browser.
export function testChromeOffKeychain({ where }: { where: string }) {
  for (const [
    name,
    launch,
  ] of Object.entries(LAUNCHES)) {
    test(
      `a Chrome started with ${name} ${where} stays off the Keychain`,
      async () => {
        const args = (await launch({ binary: fakeChrome() })).trim().split('\n')
        const end = args.indexOf('--')
        const switches = end === -1 ? args : args.slice(
          0,
          end,
        )
        const missing = KEYCHAIN_FLAGS.filter(flag => !switches.includes(flag))
        assert.deepEqual(
          missing,
          [],
          `${name} started Chrome without ${missing.join(' ')}: ${args.join(' ')}`,
        )
      },
    )
  }

  for (const [
    name,
    launch,
  ] of Object.entries(SHELL_LAUNCHES)) {
    test(
      `a Chrome started with ${name} ${where} gets only its own arguments`,
      async () => {
        const command = [
          `'${fakeChrome()}'`,
          ...CHROME_ARGS,
        ].join(' ')
        assert.deepEqual(
          (await launch({ command })).trim().split('\n'),
          CHROME_ARGS,
        )
      },
    )
  }
}
