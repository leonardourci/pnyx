import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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

    if (args[0] === 'bootout') {
      loaded = false
    }

    return ''
  }

  const options = { hydraId: 'default', port: 49123, homes: ['/fixture/home & space'], platform: 'darwin' as const, userHome: root, run, sleep: () => assert.fail('an immediate bootout needs no wait') }
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
  assert.deepEqual(calls.slice(-3).map(args => args[0]), ['bootout', 'print', 'bootstrap'])
  setupService({ ...options, remove: true })
  assert.deepEqual(calls.slice(-2).map(args => args[0]), ['bootout', 'print'])
  assert.equal(existsSync(installed.path), false)
  assert.throws(() => setupService({ ...options, platform: 'linux' }), /requires macOS/)
  assert.throws(() => setupService({ ...options, port: 0 }), /1 to 65535/)
})

test('reinstalling a running service waits for launchd to finish the bootout and retries a failed bootstrap once', () => {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-service-reinstall-'))
  process.env.PNYX_HOME = join(root, 'pnyx')
  const calls: string[] = []
  const waits: number[] = []
  let listed = true
  let unloading = 0
  let refusals = 0

  const run = ({ args }: { args: string[] }) => {
    calls.push(args[0])

    if (args[0] === 'print') {
      if (unloading > 0) {
        unloading--
      } else if (!listed) {
        throw new Error('Could not find service')
      }

      return ''
    }

    if (args[0] === 'bootout') {
      listed = false
      unloading = 3
    }

    if (args[0] === 'bootstrap') {
      if (unloading > 0 || refusals-- > 0) {
        throw new Error(`Command failed: launchctl bootstrap ${args[1]} ${args[2]}\nBootstrap failed: 5: Input/output error`)
      }

      listed = true
    }

    return ''
  }

  const options = { hydraId: 'default', platform: 'darwin' as const, userHome: root, run, sleep: ({ ms }: { ms: number }) => waits.push(ms) }
  setupService(options)
  assert.deepEqual(calls, ['print', 'bootout', 'print', 'print', 'print', 'print', 'bootstrap'])
  assert.deepEqual(waits, [100, 100, 100])
  assert.equal(listed, true)

  calls.length = 0
  waits.length = 0
  refusals = 1
  setupService(options)
  assert.deepEqual(calls.slice(-2), ['bootstrap', 'bootstrap'])
  assert.equal(waits.at(-1), 1000)
  assert.equal(listed, true)

  refusals = 2
  assert.throws(() => setupService(options), (error: Error & { code?: string }) => error.code === 'SERVICE_ERROR' && error.message.includes('Bootstrap failed: 5: Input/output error'))

  const plist = readFileSync(join(root, 'Library', 'LaunchAgents', readdirSync(join(root, 'Library', 'LaunchAgents'))[0]), 'utf8')
  const stuck = { ...options, run: ({ args }: { args: string[] }) => args[0] === 'bootstrap' ? assert.fail('a stuck job must not be replaced') : '' }

  for (const remove of [false, true]) {
    assert.throws(() => setupService({ ...stuck, remove }), (error: Error & { code?: string }) => error.code === 'SERVICE_ERROR' && /did not stop/.test(error.message))
  }

  assert.equal(readFileSync(join(root, 'Library', 'LaunchAgents', readdirSync(join(root, 'Library', 'LaunchAgents'))[0]), 'utf8'), plist)
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
