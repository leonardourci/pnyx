import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')
const run$ = promisify(execFile)

// The card ids of a search's results, best first.
const cards = (out: string) => [...out.matchAll(/^ {2}- card: (\S+)$/gm)].map(m => m[1])

// A board in a temporary home. With stub, the worker embeds with hash vectors and
// reranks by word overlap, so no model is ever downloaded or loaded, and the
// runtime folder holds only a link to the repository's sqlite-vec, so nothing is installed.
function board(stub = true) {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-sem-'))

  if (stub) {
    mkdirSync(join(home, 'runtime', 'node_modules'), { recursive: true })
    symlinkSync(join(import.meta.dirname, '..', 'node_modules', 'sqlite-vec'), join(home, 'runtime', 'node_modules', 'sqlite-vec'), 'junction')
  }

  const env = { ...process.env, PNYX_HOME: home, PNYX_SEMANTIC_STUB: stub ? '1' : '' }
  const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const fails = (args: string[], code: string, message?: RegExp) =>
    assert.throws(() => run(...args), (error: { stdout: string }) => {
      assert.match(error.stdout, new RegExp(`^code: ${code}$`, 'm'))

      if (message) {
        assert.match(error.stdout, message)
      }

      return true
    })

  const push = (key: string, card: object) => {
    const file = join(home, `${key}.json`)
    writeFileSync(file, JSON.stringify(card))
    run('push', '--key', key, '--file', file)
  }

  push('a', { title: 'Orders migration', workspace: 'work' })
  push('b', { title: 'Dark mode toggle', workspace: 'home' })
  push('c', { title: 'Flaky login test', workspace: 'home' })
  run('outcome', 'c1', 'done', '--note', 'deploy reverted because the migration locked the orders table')
  run('outcome', 'c3', 'done', '--note', 'session cookie expired before the assertion')
  // Turning semantic search off stops the worker within seconds.
  const stop = () => run('settings', 'set', 'search.semantic', 'off')

  return { home, env, run, fails, push, stop }
}

// Waits until the background worker has embedded every entry.
async function embedded(run: (...args: string[]) => string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const status = run('search', 'status')
    const m = status.match(/^vectors: (\d+) of (\d+) entries embedded$/m)

    if (m && m[1] === m[2]) {
      return status
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }

  throw new Error('the worker never finished embedding')
}

test('semantic search is off by default and search stays lexical', async () => {
  const { run, home } = board()
  assert.match(run('settings'), /^ {2}search\.semantic: off$/m)
  const out = run('search', 'orders')
  assert.match(out, /^mode: lexical$/m)
  assert.doesNotMatch(out, /^semantic:/m)
  process.env.PNYX_HOME = home
  const { workerSocket } = await import('../src/search/semantic.ts')
  assert.ok(!existsSync(workerSocket()), 'no worker starts while semantic search is off')
  delete process.env.PNYX_HOME
})

test('turning semantic search on needs the models; bad settings are refused', () => {
  const { fails } = board(false)
  fails(['settings', 'set', 'search.semantic', 'on'], 'VALIDATION_ERROR', /runtime \(node-llama-cpp@3\.22\.1 sqlite-vec@0\.1\.9\) is not installed/)
  fails(['settings', 'set', 'search.rerank', 'on'], 'VALIDATION_ERROR', /reranker is not downloaded/)
  fails(['settings', 'set', 'search.semantic', 'maybe'], 'VALIDATION_ERROR')
  fails(['settings', 'set', 'search.model', 'huge'], 'VALIDATION_ERROR')
  fails(['settings', 'set', 'nope', 'on'], 'VALIDATION_ERROR')
  fails(['search', 'setup'], 'VALIDATION_ERROR')
  fails(['search', 'setup', '--semantic', '--model', 'huge'], 'VALIDATION_ERROR')
})

test('with semantic search on but no runtime installed, search says so and stays full-text', () => {
  const { run, home } = board(false)
  const before = run('search', 'orders')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'search.semantic': 'on', 'search.rerank': 'off', 'search.model': 'granite-97m' }))
  const out = run('search', 'orders')
  assert.match(out, /^semantic: "unavailable: the semantic search runtime \(node-llama-cpp@3\.22\.1 sqlite-vec@0\.1\.9\) is not installed"$/m)
  assert.equal(out.replace(/^semantic: .*\n/m, ''), before)
  assert.match(run('search', 'status'), /^semantic: "unavailable: the semantic search runtime .* is not installed"$/m)
  assert.ok(!existsSync(join(home, 'semantic.log')), 'no worker is started without the runtime')
})

test('the worker socket sits in a folder only this user can use', { skip: process.platform === 'win32' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pnyx-sock-'))
  const saved = { TMPDIR: process.env.TMPDIR, PNYX_HOME: process.env.PNYX_HOME }
  process.env.TMPDIR = tmp
  process.env.PNYX_HOME = join(tmp, 'x'.repeat(200))

  try {
    const { workerSocket } = await import('../src/search/semantic.ts')
    const dir = join(tmp, `pnyx-${process.getuid!()}`)
    const socket = workerSocket()
    // The long home is hashed into the name, so the path's length depends only on the temp folder.
    assert.match(socket, new RegExp(`^${dir}/semantic-[0-9a-f]{16}\\.sock$`))
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    chmodSync(dir, 0o777)
    assert.throws(() => workerSocket(), /must be a folder only this user can use/)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  }
})

test('setup turns semantic search on; hybrid search finds cards by meaning and by words', async () => {
  const { run, stop } = board()

  try {
    const setup = run('search', 'setup', '--semantic')
    assert.match(setup, /^semantic: on$/m)
    assert.match(setup, /^mode: stub$/m)
    assert.match(setup, /^rerank: on$/m)
    run('settings', 'set', 'search.rerank', 'off')
    const status = await embedded(run)
    assert.match(status, /^semantic: "on: stub, 64 dimensions"$/m)
    assert.match(status, /^mode: "hybrid: words fused with meaning"$/m)

    // "reverted cookie": no card holds both words, so the full-text leg finds nothing; meaning finds both.
    const meaning = run('search', 'reverted', 'cookie')
    assert.match(meaning, /^mode: hybrid$/m)
    assert.match(meaning, /^semantic: "ready: stub"$/m)
    assert.deepEqual(cards(meaning).slice(0, 2)
      .sort(), ['c1', 'c3'])
    assert.match(meaning, /^ {4}match: semantic$/m)
    assert.match(meaning, /^ {6}event,"[^"]+",deploy reverted because the migration locked the orders table$/m)

    // A card found both ways ranks first, with its full-text snippets.
    const both = run('search', 'orders')
    assert.equal(cards(both)[0], 'c1')
    assert.match(both, /^ {4}match: both$/m)
    assert.match(both, /\[orders\] table/)

    // Filters apply to both legs; --lexical and --card search by words only.
    const homeOnly = cards(run('search', 'reverted', 'cookie', '--workspace', 'home'))
    assert.equal(homeOnly[0], 'c3')
    assert.ok(!homeOnly.includes('c1'))
    assert.match(run('search', 'reverted', 'cookie', '--lexical'), /^mode: lexical\nresults: "none: /m)
    assert.match(run('search', 'orders', '--card', 'c1'), /^mode: lexical$/m)
  } finally {
    stop()
  }
})

test('the reranker reorders the top results, marks weak ones and says when nothing matches strongly', async () => {
  const { run, stop } = board()

  try {
    run('search', 'setup', '--semantic')
    await embedded(run)
    // The stub reranker scores the share of query words a card's nearest entry holds.
    const strong = run('search', 'session', 'cookie', 'expired')
    assert.match(strong, /^mode: "hybrid, reranked"$/m)
    assert.equal(cards(strong)[0], 'c3')
    assert.doesNotMatch(strong, /^note:/m)
    assert.match(strong, /^ {2}- card: c1\n(?: {4}.*\n)*? {4}weak: true$/m)
    const vague = run('search', 'cookie', 'dinosaur')
    assert.match(vague, /^note: "no strong match: /m)
  } finally {
    stop()
  }
})

test('turned off, search output is exactly what it was before setup', async () => {
  const { run, stop } = board()
  const queries = [['orders'], ['reverted', 'cookie'], ['migraton'], ['orders', '--card', 'c1']]
  const before = queries.map(q => run('search', ...q))
  run('search', 'setup', '--semantic')
  await embedded(run)
  stop()
  assert.deepEqual(queries.map(q => run('search', ...q)), before)
})

test('a changed model drops the vectors and embeds again; the worker answers every board', async () => {
  const { run, stop, home, env } = board()

  try {
    run('search', 'setup', '--semantic')
    await embedded(run)
    const db = join(home, 'boards', 'default', 'search.db')
    // Another backend's vectors are not used: the key no longer matches, so they are re-made.
    const { sqlite } = await import('../src/search/index.ts')
    const { DatabaseSync } = sqlite()
    const w = new DatabaseSync(db)
    w.prepare("UPDATE meta SET value = 'other' WHERE key = 'embed.key'").run()
    w.close()
    assert.match(run('search', 'status'), /^vectors: 0 of \d+ entries embedded$/m)
    run('search', 'orders')
    await embedded(run)
    // A second board shares the worker.
    const other = await run$(process.execPath, [BIN, 'search', 'anything', '--board', 'second'], { env })
    assert.match(other.stdout, /^results: "none: /m)
  } finally {
    stop()
  }
})

test('a model download is checked against its pinned size and SHA-256', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-dl-'))
  process.env.PNYX_HOME = home
  const { download, modelPath } = await import('../src/search/models.ts')
  const body = Buffer.from('not really a model')
  const server = createServer((_req, res) => res.end(body))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/m.gguf`
    const sha256 = createHash('sha256').update(body)
      .digest('hex')
    const good = { file: 'm.gguf', url, sha256, bytes: body.length }
    await assert.rejects(download({ ...good, file: 'bad.gguf', sha256: '0'.repeat(64) }), /does not match its pin/)
    assert.ok(!existsSync(modelPath({ ...good, file: 'bad.gguf' })) && !existsSync(`${modelPath({ ...good, file: 'bad.gguf' })}.part`))
    assert.equal(await download(good), 'downloaded')
    assert.deepEqual(readFileSync(modelPath(good)), body)
    assert.equal(await download(good), 'present')
  } finally {
    server.close()
    delete process.env.PNYX_HOME
  }
})
