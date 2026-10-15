import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setupService } from '../src/server/service.ts'

test('login service starts the same board, survives exit and uninstalls through launchd', () => {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-service-'))
  process.env.PNYX_HOME = join(root, 'pnyx & board')
  const calls: string[][] = []
  let loaded = false

  const run = ({ args }: { args: string[] }) => {
    calls.push(args)

    if (args[0] === 'print' && !loaded) {
      throw new Error('not loaded')
    }

    if (args[0] === 'bootstrap') {
      loaded = true
    }

    return ''
  }

  const options = { board: 'default', port: 49123, homes: ['/fixture/home & space'], platform: 'darwin' as const, userHome: root, run }
  const preview = setupService({ ...options, preview: true })
  assert.equal(calls.length, 0)
  assert.equal(existsSync(preview.path), false)
  const installed = setupService(options)
  const plist = readFileSync(installed.path, 'utf8')
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/)
  assert.match(plist, /<string>serve<\/string><string>--board<\/string><string>default<\/string>/)
  assert.match(plist, /49123/)
  assert.match(plist, /home &amp; space/)
  assert.match(plist, /pnyx &amp; board/)
  assert.equal(calls.at(-1)?.[0], 'bootstrap')
  setupService(options)
  assert.equal(calls.at(-2)?.[0], 'bootout')
  setupService({ ...options, remove: true })
  assert.equal(calls.at(-1)?.[0], 'bootout')
  assert.equal(existsSync(installed.path), false)
  assert.throws(() => setupService({ ...options, platform: 'linux' }), /requires macOS/)
  assert.throws(() => setupService({ ...options, port: 0 }), /1 to 65535/)
})
