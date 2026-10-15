import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { setupService } from '../src/server/service.ts'

test('login service starts the same Hydra, survives exit and uninstalls through launchd', () => {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-service-'))
  process.env.PNYX_HOME = join(root, 'pnyx & Hydra')
  const calls: string[][] = []
  let loaded = false

  const run = ({ args }: { args: string[] }) => {
    calls.push(args)

    if (args[0] === 'print' && !loaded) {
      throw new Error('not loaded')
    }

    if (args[0] === 'bootstrap') {
      assert.ok(existsSync(join(process.env.PNYX_HOME!, 'boards', 'default')))
      loaded = true
    }

    return ''
  }

  const options = { hydraId: 'default', port: 49123, homes: ['/fixture/home & space'], platform: 'darwin' as const, userHome: root, run }
  const preview = setupService({ ...options, preview: true })
  assert.equal(calls.length, 0)
  assert.equal(existsSync(preview.path), false)
  const installed = setupService(options)
  const plist = readFileSync(installed.path, 'utf8')
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/)
  assert.match(plist, /<string>serve<\/string><string>--hydra<\/string><string>default<\/string>/)
  assert.match(plist, /49123/)
  assert.match(plist, /home &amp; space/)
  assert.match(plist, /pnyx &amp; hydraId/)
  assert.equal(calls.at(-1)?.[0], 'bootstrap')
  setupService(options)
  assert.equal(calls.at(-2)?.[0], 'bootout')
  setupService({ ...options, remove: true })
  assert.equal(calls.at(-1)?.[0], 'bootout')
  assert.equal(existsSync(installed.path), false)
  assert.throws(() => setupService({ ...options, platform: 'linux' }), /requires macOS/)
  assert.throws(() => setupService({ ...options, port: 0 }), /1 to 65535/)
})

test('login service runs Node through a PATH link that survives a Homebrew upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-service-node-'))
  process.env.PNYX_HOME = join(root, 'pnyx')
  const cellar = join(root, 'Cellar', 'node', '26.4.0', 'bin')
  const other = join(root, 'other')
  const bin = join(root, 'bin')

  for (const dir of [cellar, other, bin]) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(join(cellar, 'node'), '')
  writeFileSync(join(other, 'node'), '')
  symlinkSync(join(cellar, 'node'), join(bin, 'node'))
  const options = { hydraId: 'default', platform: 'darwin' as const, userHome: root, preview: true, node: join(cellar, 'node'), run: () => '' }
  const linked = setupService({ ...options, searchPath: ['relative', other, bin].join(delimiter) }).plist!
  assert.ok(linked.includes(`<array><string>${join(bin, 'node')}</string>`))
  const unlinked = setupService({ ...options, searchPath: other }).plist!
  assert.ok(unlinked.includes(`<array><string>${join(cellar, 'node')}</string>`))
  const missing = setupService({ ...options, node: join(root, 'gone', 'node'), searchPath: bin }).plist!
  assert.ok(missing.includes(`<array><string>${join(root, 'gone', 'node')}</string>`))
})
