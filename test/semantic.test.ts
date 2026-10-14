import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')
const run$ = promisify(execFile)

// The card ids of a search's results, best first.
const cards = ({ out }: { out: string }) => [...out.matchAll(/^ {2}- card: (\S+)$/gm)].map(m => m[1])

// A board in a temporary home. With stub, the worker embeds with hash vectors and
// reranks by word overlap, so no model is ever downloaded or loaded.
function board({ extra = {} }: { extra?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-sem-'))
  const env = { ...process.env, PNYX_HOME: home, PNYX_SEMANTIC_STUB: '1', ...extra }
  const run = ({ args = [] }: { args?: string[] } = {}) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const fails = ({ args, code, message }: { args: string[]; code: string; message?: RegExp }) =>
    assert.throws(() => run({ args: [...args] }), (error: { stdout: string }) => {
      assert.match(error.stdout, new RegExp(`^code: ${code}$`, 'm'))

      if (message) {
        assert.match(error.stdout, message)
      }

      return true
    })

  const push = ({ key, card }: { key: string; card: object }) => {
    const file = join(home, `${key}.json`)
    writeFileSync(file, JSON.stringify(card))
    run({ args: ['push', '--key', key, '--file', file] })
  }

  push({ key: 'a', card: { title: 'Orders migration', workspace: 'work' } })
  push({ key: 'b', card: { title: 'Dark mode toggle', workspace: 'home' } })
  push({ key: 'c', card: { title: 'Flaky login test', workspace: 'home' } })
  run({ args: ['outcome', 'c1', 'done', '--note', 'deploy reverted because the migration locked the orders table'] })
  run({ args: ['outcome', 'c3', 'done', '--note', 'session cookie expired before the assertion'] })
  // Turning semantic search off stops the worker within seconds.
  const stop = () => run({ args: ['settings', 'set', 'search.semantic', 'off'] })

  // The same command with semantic search off for this process: the full-text output.
  const lexical = ({ args = [] }: { args?: string[] } = {}) => execFileSync(process.execPath, [BIN, ...args], { env: { ...env, PNYX_SEMANTIC: 'off' }, encoding: 'utf8' })

  return { home, env, run, lexical, fails, push, stop }
}

// Waits until the background worker has its models and has embedded every entry.
async function embedded({ run }: {
  run: (
    { args }: {
      args?: string[]
    },
  ) => string
}): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const status = run({ args: ['search', 'status'] })
    const m = status.match(/^vectors: (\d+) of (\d+) entries embedded$/m)

    if (m && m[1] === m[2] && /^rerank: (on|off)$/m.test(status)) {
      return status
    }

    run({ args: ['search', 'orders'] })
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  throw new Error('the worker never finished embedding')
}

test('semantic search is on by default; models are picked for the machine', async () => {
  const { run, stop } = board({ })

  try {
    assert.match(run({ args: ['settings'] }), /^ {2}search\.semantic: on\n {2}search\.rerank: auto\n {2}search\.model: auto$/m)
    const status = await embedded({ run })
    // The stub counts as a GPU machine: the 311m-sized stub embedder and the reranker.
    assert.match(status, /^semantic: "on: granite-311m on stub, 64 dimensions"$/m)
    assert.match(status, /^rerank: on$/m)
    assert.match(run({ args: ['search', 'reverted', 'cookie'] }), /^mode: "hybrid, reranked"$/m)
  } finally {
    stop()
  }
})

test('while a model downloads, search is full-text and shows the progress', async () => {
  const { run, lexical: off, stop } = board({ extra: { PNYX_SEMANTIC_STUB_DOWNLOAD_MS: '4000' } })

  try {
    const lexical = off({ args: ['search', 'orders'] })
    let out = run({ args: ['search', 'orders'] })

    for (let i = 0; i < 20 && !/downloading/.test(out); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      out = run({ args: ['search', 'orders'] })
    }

    assert.match(out, /^semantic: "downloading the model, \d+% of 347 MB; full-text results until it is ready"$/m)
    assert.equal(out.replace(/^semantic: .*\n/m, ''), lexical)
    assert.match(run({ args: ['search', 'status'] }), /^semantic: "preparing \(stub\): downloading the model, \d+% of 347 MB; full-text results until it is ready"$/m)
    await embedded({ run })
    assert.match(run({ args: ['search', 'orders'] }), /^mode: "hybrid, reranked"$/m)
  } finally {
    stop()
  }
})

test('bad settings are refused; PNYX_SEMANTIC=off and the setting turn semantic search off', async () => {
  const { run, fails, home, env } = board({ extra: { PNYX_SEMANTIC: 'off' } })
  fails({ args: ['settings', 'set', 'search.semantic', 'maybe'], code: 'VALIDATION_ERROR' })
  fails({ args: ['settings', 'set', 'search.rerank', 'sometimes'], code: 'VALIDATION_ERROR' })
  fails({ args: ['settings', 'set', 'search.model', 'huge'], code: 'VALIDATION_ERROR' })
  fails({ args: ['settings', 'set', 'nope', 'on'], code: 'VALIDATION_ERROR' })
  fails({ args: ['search', 'setup'], code: 'VALIDATION_ERROR' })
  // The variable wins over the file but is never written to it.
  run({ args: ['settings', 'set', 'search.rerank', 'off'] })
  assert.match(readFileSync(join(home, 'settings.json'), 'utf8'), /"search\.semantic": "on"/)
  const out = run({ args: ['search', 'orders'] })
  assert.match(out, /^mode: lexical$/m)
  assert.doesNotMatch(out, /^semantic:/m)
  assert.match(run({ args: ['search', 'status'] }), /^semantic: "off: /m)
  process.env.PNYX_HOME = home
  const { workerSocket } = await import('../src/search/semantic.ts')
  assert.ok(!existsSync(workerSocket()), 'no worker starts while semantic search is off')
  delete process.env.PNYX_HOME
  void env
})

test('after a failure, search stays full-text and says so until setup retries', async () => {
  const { run, home, stop } = board({ })

  try {
    writeFileSync(join(home, 'semantic-failure.json'), JSON.stringify({ message: 'download of x failed: HTTP 503', until: Date.now() + 60_000 }))
    const out = run({ args: ['search', 'orders'] })
    assert.match(out, /^semantic: "unavailable: download of x failed: HTTP 503; run `pnyx-axi search setup --semantic` to retry now"$/m)
    assert.match(out, /^mode: lexical$/m)
    run({ args: ['search', 'setup', '--semantic'] })
    assert.ok(!existsSync(join(home, 'semantic-failure.json')))
    await embedded({ run })
  } finally {
    stop()
  }
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
  const { run, lexical, stop } = board({ })

  try {
    const setup = run({ args: ['search', 'setup', '--semantic'] })
    assert.match(setup, /^semantic: on$/m)
    assert.match(setup, /^mode: stub$/m)
    assert.match(setup, /^model: granite-311m$/m)
    assert.match(setup, /^rerank: on$/m)
    run({ args: ['settings', 'set', 'search.rerank', 'off'] })
    const status = await embedded({ run })
    assert.match(status, /^semantic: "on: granite-311m on stub, 64 dimensions"$/m)
    assert.match(status, /^mode: "hybrid: words fused with meaning"$/m)

    // "reverted cookie": no card holds both words, so the full-text leg finds nothing; meaning finds both.
    const meaning = run({ args: ['search', 'reverted', 'cookie'] })
    assert.match(meaning, /^mode: hybrid$/m)
    assert.match(meaning, /^semantic: "ready: granite-311m on stub"$/m)
    assert.deepEqual(cards({ out: meaning }).slice(0, 2)
      .sort(), ['c1', 'c3'])
    assert.match(meaning, /^ {4}match: semantic$/m)
    assert.match(meaning, /^ {6}event,"[^"]+",deploy reverted because the migration locked the orders table$/m)

    // A card found both ways ranks first, with its full-text snippets.
    const both = run({ args: ['search', 'orders'] })
    assert.equal(cards({ out: both })[0], 'c1')
    assert.match(both, /^ {4}match: both$/m)
    assert.match(both, /\[orders\] table/)

    // Filters apply to both legs; with semantic search off, words only.
    const homeOnly = cards({ out: run({ args: ['search', 'reverted', 'cookie', '--workspace', 'home'] }) })
    assert.equal(homeOnly[0], 'c3')
    assert.ok(!homeOnly.includes('c1'))
    assert.match(lexical({ args: ['search', 'reverted', 'cookie'] }), /^mode: lexical\nresults: "none: /m)

    // --card ranks one card's entries the same way: no entry holds both words, yet meaning finds one.
    const entries = run({ args: ['search', 'table', 'dinosaur', '--card', 'c1'] })
    assert.match(entries, /^mode: hybrid$/m)
    assert.match(entries, /^ {4}match: semantic$/m)
    assert.match(entries, /^ {6}event,"[^"]+",deploy reverted because the migration locked the orders table$/m)
    assert.match(lexical({ args: ['search', 'table', 'dinosaur', '--card', 'c1'] }), /^results: "none: /m)
  } finally {
    stop()
  }
})

test('without the reranker, a card found by meaning alone is weak under the similarity floor', async () => {
  const { run, stop } = board({ })

  try {
    run({ args: ['settings', 'set', 'search.rerank', 'off'] })
    await embedded({ run })
    // An unrelated query: every card is somewhere in the vector order, but none is near enough.
    const unrelated = run({ args: ['search', 'dinosaur', 'banana'] })
    assert.equal(cards({ out: unrelated }).length, 3)
    assert.equal(unrelated.match(/^ {4}weak: true$/gm)?.length, 3)
    // Most of the query's words in one entry: that card is strong, the others weak.
    const near = run({ args: ['search', 'session', 'cookie', 'expired', 'dinosaur'] })
    assert.equal(cards({ out: near })[0], 'c3')
    assert.match(near, /^ {2}- card: c3\n(?: {4}(?!weak).*\n)*(?! {4})/m)
    assert.equal(near.match(/^ {4}weak: true$/gm)?.length, 2)
  } finally {
    stop()
  }
})

test('a recorded reranker failure keeps searches on the embedder alone until setup clears it', async () => {
  const { run, home, stop } = board({ })

  try {
    writeFileSync(join(home, 'reranker-failure.json'), JSON.stringify({ message: 'download of r failed: HTTP 503', until: Date.now() + 60_000 }))
    let status = ''

    for (let i = 0; i < 100 && !/^vectors: (\d+) of \1 /m.test(status); i += 1) {
      run({ args: ['search', 'orders'] })
      await new Promise(resolve => setTimeout(resolve, 100))
      status = run({ args: ['search', 'status'] })
    }

    assert.match(status, /^semantic: "on: /m)
    assert.match(status, /^rerank: "the reranker failed: download of r failed: HTTP 503"$/m)
    assert.match(run({ args: ['search', 'orders'] }), /^mode: hybrid$/m)
    run({ args: ['search', 'setup', '--semantic'] })
    assert.ok(!existsSync(join(home, 'reranker-failure.json')))
  } finally {
    stop()
  }
})

test('the reranker reorders the top results, marks weak ones and says when nothing matches strongly', async () => {
  const { run, stop } = board({ })

  try {
    run({ args: ['search', 'setup', '--semantic'] })
    await embedded({ run })
    // The stub reranker scores the share of query words a card's nearest entry holds.
    const strong = run({ args: ['search', 'session', 'cookie', 'expired'] })
    assert.match(strong, /^mode: "hybrid, reranked"$/m)
    assert.equal(cards({ out: strong })[0], 'c3')
    assert.doesNotMatch(strong, /^note:/m)
    assert.match(strong, /^ {2}- card: c1\n(?: {4}.*\n)*? {4}weak: true$/m)
    const vague = run({ args: ['search', 'cookie', 'dinosaur'] })
    assert.match(vague, /^note: "no strong match: /m)
  } finally {
    stop()
  }
})

test('turned off, search output is exactly the full-text output', async () => {
  const { run, stop, env } = board({ })
  const queries = [['orders'], ['reverted', 'cookie'], ['migraton'], ['orders', '--card', 'c1']]
  const off = ({ args = [] }: { args?: string[] } = {}) => execFileSync(process.execPath, [BIN, ...args], { env: { ...env, PNYX_SEMANTIC: 'off' }, encoding: 'utf8' })
  const before = queries.map(q => off({ args: ['search', ...q] }))
  run({ args: ['search', 'setup', '--semantic'] })
  await embedded({ run })
  stop()
  assert.deepEqual(queries.map(q => run({ args: ['search', ...q] })), before)
})

test('a changed model drops the vectors and embeds again; the worker answers every board', async () => {
  const { run, stop, home, env } = board({ })

  try {
    run({ args: ['search', 'setup', '--semantic'] })
    await embedded({ run })
    const db = join(home, 'boards', 'default', 'search.db')
    // Another backend's vectors are not used: the key no longer matches, so they are re-made.
    const { sqlite } = await import('../src/search/index.ts')
    const { DatabaseSync } = sqlite()
    const w = new DatabaseSync(db)
    w.prepare("UPDATE meta SET value = 'other' WHERE key = 'embed.key'").run()
    w.close()
    assert.match(run({ args: ['search', 'status'] }), /^vectors: 0 of \d+ entries embedded$/m)
    run({ args: ['search', 'orders'] })
    await embedded({ run })
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
    await assert.rejects(download({ model: { ...good, file: 'bad.gguf', sha256: '0'.repeat(64) } }), /does not match its pin/)
    assert.ok(!existsSync(modelPath({ model: { ...good, file: 'bad.gguf' } })) && !existsSync(`${modelPath({ model: { ...good, file: 'bad.gguf' } })}.part`))
    assert.equal(await download({ model: good }), 'downloaded')
    assert.deepEqual(readFileSync(modelPath({ model: good })), body)
    assert.equal(await download({ model: good }), 'present')
  } finally {
    server.close()
    delete process.env.PNYX_HOME
  }
})
