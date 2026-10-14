import { seedWebFixture } from './web-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { WebSocket } from 'ws'
import { BoardError } from '../src/core/model.ts'
import { startServer, type RunningServer, type ServerMessage } from '../src/server/server.ts'
import { infoPath, localToken, socketPath } from '../src/server/state.ts'
import { boardDir, loadBoard, spoolDir, spoolWrite, withWriter } from '../src/store/board-store.ts'
import { decidePush } from '../src/core/decide.ts'
import { indexStatus, searchPath } from '../src/search/index.ts'
import { writeSetting } from '../src/search/settings.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')
const TIMEOUT_MS = 3000
// CLI children start a fresh node process; under a parallel test run that can take far longer than a poll.
const CLI_TIMEOUT_MS = 30000

let server: RunningServer | undefined
// Every tab a test opens, closed after it even when it fails.
const tabs = new Set<WebSocket>()

beforeEach(() => {
  // Every test gets its own home; nothing touches the real ~/.pnyx.
  process.env.PNYX_HOME = mkdtempSync(join(tmpdir(), 'pnyx-server-'))
})

afterEach(async () => {
  for (const ws of tabs) {
    // A refused handshake reports its own end as an error; that is expected here.
    ws.on('error', () => {})
    ws.terminate()
  }

  tabs.clear()
  await server?.close()
  server = undefined
})

const cli = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS })

const hookEvent = (id: string, key: string, title: string) => ({ id, key, at: '2026-10-13T14:00:00Z', actor: 'hook', card: { title } })

async function until<T>(check: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS

  for (;;) {
    const value = check()

    if (value !== undefined) {
      return value
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await new Promise(r => setTimeout(r, 20))
  }
}

const seqIs = (seq: number, board = 'default') => until(() => (loadBoard(board).state.seq === seq ? true : undefined), `seq ${seq}`)

async function sendToSocket(path: string, text: string): Promise<void> {
  const conn = connect(path)
  await once(conn, 'connect')
  conn.end(text)
  await once(conn, 'close')
}

function inbox<T>() {
  const queue: T[] = []
  const waiting: ((m: T) => void)[] = []

  return {
    queue,
    put(message: T) {
      const waiter = waiting.shift()

      if (waiter) {
        waiter(message)
      } else {
        queue.push(message)
      }
    },
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => {
            // A wait that timed out must not swallow the message that arrives after it.
            waiting.splice(waiting.indexOf(waiter), 1)
            reject(new Error('timed out waiting for a message'))
          }, TIMEOUT_MS).unref()

          const waiter = (m: T) => {
            clearTimeout(timer)
            resolve(m)
          }

          waiting.push(waiter)
        }),
  }
}

type LatestMessages = Extract<ServerMessage, { type: 'latest' }>['messages']

// Last-message pushes arrive on their own queue, so the other messages keep their order.
async function tab(query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws?token=${localToken()}${query.replace('?', '&')}`)
  tabs.add(ws)
  const main = inbox<ServerMessage>(), latest = inbox<LatestMessages>()
  const queue = main.queue
  ws.on('message', data => {
    const message = JSON.parse(String(data)) as ServerMessage

    if (message.type === 'latest') {
      latest.put(message.messages)
    } else {
      main.put(message)
    }
  })
  await once(ws, 'open')
  // Every connection opens with the server's build.
  const hello = await main.next()
  assert.equal(hello.type, 'hello')

  return {
    ws,
    hello,
    next: main.next,
    // The next last-message push that includes this card.
    async latest(card: string) {
      for (;;) {
        const messages = await latest.next()

        if (card in messages) {
          return messages[card]
        }
      }
    },
    command(id: string, name: string, args: string[]) {
      ws.send(JSON.stringify({ type: 'command', id, name, args }))
    },
    // Nothing arrives within a short quiet period.
    async idle() {
      await new Promise(r => setTimeout(r, 150))
      assert.deepEqual(queue, [])
    },
  }
}

function http(method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{
    status: number
    headers: Record<string, unknown>
    text: string
  }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server!.port, method, path, headers }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function handshakeStatus(
  query: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws${query}`, { headers })
  tabs.add(ws)
  const [, response] = await once(ws, 'unexpected-response')

  return response.statusCode
}

async function boardWithCard(board = 'default') {
  server = await startServer({ board })
  await sendToSocket(server.socket!, JSON.stringify(hookEvent('hook-1', 'a', 'A')))
  await seqIs(1, board)

  return loadBoard(board).state.keys.a!
}

test('serve runs until stop, and the summary reports it without starting it', async t => {
  const before = cli()
  assert.match(before, /^server: not running$/m)
  assert.match(before, /pnyx-axi serve/)
  assert.equal(existsSync(infoPath('default')), false)

  const child = spawn(process.execPath, [BIN, 'serve', '--port', '0'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  // A failed assertion must not leave the piped child keeping this test file alive.
  t.after(() => child.kill())
  let out = ''
  child.stdout.on('data', chunk => (out += chunk))
  const url = await until(() => /^url: "(http:\/\/127\.0\.0\.1:\d+)"$/m.exec(out)?.[1], 'serve to start')
  await until(() => (existsSync(infoPath('default')) ? true : undefined), 'server.json')
  assert.match(cli(), new RegExp(`^server: "running at ${url}"$`, 'm'))
  assert.ok(existsSync(socketPath('default')))

  assert.match(cli('stop'), /^server: stopped$/m)
  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
  assert.match(out, /^server: stopped$/m)
  assert.equal(existsSync(infoPath('default')), false)
  assert.equal(existsSync(socketPath('default')), false)
  assert.match(cli(), /^server: not running$/m)
  assert.match(cli('stop'), /^server: "none: not running"$/m)
})

test('serve refuses a taken port instead of picking another', async t => {
  const holder = createServer().listen(0, '127.0.0.1')
  await once(holder, 'listening')
  const { port } = holder.address() as { port: number }

  try {
    const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => child.kill())
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    const [code] = await once(child, 'exit')
    assert.notEqual(code, 0)
    assert.match(out, new RegExp(`port ${port} is in use`))
    assert.match(out, /PORT_IN_USE/)
    assert.match(out, /--port/)
  } finally {
    holder.close()
  }
})

test('a second server for the same board is refused', async () => {
  server = await startServer({ board: 'default' })
  await assert.rejects(startServer({ board: 'default' }), error => error instanceof BoardError && error.code === 'ALREADY_RUNNING')
})

test('hook events on the socket become cards and reach open tabs', async () => {
  server = await startServer({ board: 'default' })
  const t = await tab()
  assert.deepEqual(await t.next(), { type: 'snapshot', seq: 0, state: loadBoard('default').state })

  const event = JSON.stringify(hookEvent('hook-1', 'session-a', 'Fix the parser'))
  // A repeated event id is ingested once; a line that is not JSON is dropped.
  await sendToSocket(server.socket!, `${event}\nnot json\n${event}`)
  const message = await t.next()
  assert.equal(message.type, 'event')
  assert.equal(message.type === 'event' && message.event.seq, 1)
  assert.equal(message.type === 'event' && message.event.id, 'hook-1')
  await t.idle()
  const { state } = loadBoard('default')
  assert.equal(state.cards[state.keys['session-a']!]!.title, 'Fix the parser')
  assert.deepEqual(readdirSync(spoolDir(boardDir('default'))), [])
})

test('spooled hook events are drained on start and while running', async () => {
  spoolWrite('default', hookEvent('hook-1', 'session-a', 'Written while the server was down'))
  server = await startServer({ board: 'default' })
  await seqIs(1)
  spoolWrite('default', hookEvent('hook-2', 'session-b', 'Spooled while it runs'))
  await seqIs(2)
  const { state } = loadBoard('default')
  assert.deepEqual(Object.keys(state.keys).sort(), ['session-a', 'session-b'])
  assert.deepEqual(readdirSync(spoolDir(boardDir('default'))), [])
})

test('a tab resumes from its cursor, gets CLI writes, and resyncs with a snapshot on a gap', async () => {
  server = await startServer({ board: 'default' })
  await sendToSocket(server.socket!, `${JSON.stringify(hookEvent('hook-1', 'a', 'A'))}\n${JSON.stringify(hookEvent('hook-2', 'b', 'B'))}\n`)
  await seqIs(2)

  const behind = await tab('?after=1')
  const caughtUp = await behind.next()
  assert.equal(caughtUp.type === 'event' && caughtUp.event.seq, 2)
  await behind.idle()

  const current = await tab('?after=2')
  await current.idle()

  // A cursor the server cannot continue from gets the whole board instead.
  const ahead = await tab('?after=99')
  const snapshot = await ahead.next()
  assert.equal(snapshot.type, 'snapshot')
  assert.equal(snapshot.type === 'snapshot' && snapshot.seq, 2)

  // A tab that notices a gap itself asks for a snapshot.
  current.ws.send(JSON.stringify({ type: 'resync' }))
  const resynced = await current.next()
  assert.equal(resynced.type === 'snapshot' && resynced.seq, 2)

  // The CLI stays a writer of the same log; the server pushes what it appends.
  const cardId = loadBoard('default').state.keys.a!
  cli('move', cardId, 'review')
  const moved = await current.next()
  assert.equal(moved.type === 'event' && moved.event.seq, 3)
  assert.equal(moved.type === 'event' && moved.event.type, 'card.moved')
})

test("a tab gets its write's event before the receipt with its request id, recorded as web", async () => {
  const cardId = await boardWithCard()
  const t = await tab('?after=1')

  t.command('req-1', 'move', [cardId, 'review'])
  const pushed = await t.next()
  assert.equal(pushed.type === 'event' && pushed.event.type, 'card.moved')
  assert.equal(pushed.type === 'event' && pushed.event.actor, 'web')
  const receipt = await t.next()
  assert.equal(receipt.type, 'receipt')
  assert.equal(receipt.type === 'receipt' && receipt.id, 'req-1')
  assert.deepEqual(receipt.type === 'receipt' && receipt.card, { id: cardId, column: 'review', revision: 2 })

  t.command('req-2', 'outcome', [cardId, 'done', '--actor', 'leo'])
  const outcome = await t.next()
  assert.equal(outcome.type === 'event' && outcome.event.actor, 'leo')
  assert.equal((await t.next()).type, 'receipt')
})

test('a bad command gets an error carrying its request id and writes nothing', async () => {
  const cardId = await boardWithCard()
  const t = await tab('?after=1')

  const cases: [string, string, unknown, string][] = [
    ['r1', 'push', ['--key', 'x', '--file', '/etc/hosts'], 'NOT_FOUND'],
    ['r2', 'move', 'not a list', 'VALIDATION_ERROR'],
    ['r3', 'move', ['no-such-card', 'review'], 'NOT_FOUND'],
    ['r4', 'move', [cardId, 'review', '--board', 'other'], 'VALIDATION_ERROR'],
    ['r5', 'move', [cardId, 'review', '--board=other'], 'VALIDATION_ERROR'],
    ['r6', 'catalog', [cardId, '/arbitrary/path'], 'VALIDATION_ERROR'],
    ['r7', 'catalog', ['no-such-card'], 'NOT_FOUND'],
  ]

  for (const [id, name, args, code] of cases) {
    t.ws.send(JSON.stringify({ type: 'command', id, name, args }))
    const reply = await t.next()
    assert.equal(reply.type, 'error')
    assert.equal(reply.type === 'error' && reply.id, id)
    assert.equal(reply.type === 'error' && reply.code, code, `${id}: ${reply.type === 'error' && reply.error}`)
  }

  await t.idle()
  assert.equal(loadBoard('default').state.seq, 1)
  assert.equal(existsSync(boardDir('other')), false)
})

test("writes through the server always land on the server's own board", async () => {
  const cardId = await boardWithCard('work')
  const t = await tab('?after=1')
  t.command('req-1', 'move', [cardId, 'review'])
  assert.equal((await t.next()).type, 'event')
  assert.equal((await t.next()).type, 'receipt')
  await seqIs(2, 'work')
  assert.equal(loadBoard('work').state.cards[cardId]!.column, 'review')
  assert.equal(loadBoard('default').state.seq, 0)
})

test('the WebSocket handshake needs the token, an exact host and an exact origin', async () => {
  server = await startServer({ board: 'default' })
  const token = `?token=${localToken()}`
  assert.equal(await handshakeStatus(''), 401)
  assert.equal(await handshakeStatus('?token=wrong'), 401)
  assert.equal(await handshakeStatus(token, { origin: 'http://evil.example' }), 403)
  assert.equal(await handshakeStatus(token, { origin: `http://127.0.0.1:${server.port}.evil.example` }), 403)
  assert.equal(await handshakeStatus(token, { host: `evil.example:${server.port}` }), 403)

  const ok = new WebSocket(`ws://127.0.0.1:${server.port}/ws${token}`, { headers: { origin: `http://localhost:${server.port}` } })
  tabs.add(ok)
  await once(ok, 'open')
  ok.close()
})

test('the board page carries the token only for its own host and origin; /health names the board', async () => {
  server = await startServer({ board: 'default' })
  const meta = `<meta name="pnyx-token" content="${localToken()}" />`

  for (const path of ['/', '/index.html', '/some/route']) {
    const page = await http('GET', path, { origin: `http://127.0.0.1:${server.port}` })
    assert.equal(page.status, 200)
    assert.ok(page.text.includes(meta), path)
    assert.equal(page.headers['cache-control'], 'no-store')
  }

  for (const headers of [{ host: `evil.example:${server.port}` }, { origin: 'http://evil.example' }] as Record<string, string>[]) {
    const refused = await http('GET', '/', headers)
    assert.equal(refused.status, 403)
    assert.ok(!refused.text.includes(localToken()))
  }

  const health = await http('GET', '/health')
  assert.equal(health.status, 200)
  const { build } = JSON.parse(health.text) as { build: string }
  assert.deepEqual(JSON.parse(health.text), { board: 'default', pid: process.pid, build })
  assert.match(build, /^[0-9a-f]{12}$/)
  assert.ok((await http('GET', '/')).text.includes(`<meta name="pnyx-build" content="${build}" />`))
  assert.deepEqual((await tab()).hello, { type: 'hello', build })
  assert.equal((await http('GET', '/api/commands/move')).status, 200)
  assert.equal((await http('POST', '/api/commands/move')).status, 405)
})

test('a server.json left by a dead server is not trusted, even when its pid was reused', async () => {
  // A live process that is not a Pnyx server, and a port nothing listens on.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' })
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise(r => probe.close(r))

  try {
    mkdirSync(boardDir('default'), { recursive: true })
    writeFileSync(infoPath('default'), JSON.stringify({ pid: other.pid, port, url: `http://127.0.0.1:${port}`, socket: null }))

    assert.match(cli(), /^server: not running$/m)
    assert.match(cli('stop'), /^server: "none: not running"$/m)
    assert.equal(other.exitCode, null)
    assert.equal(other.signalCode, null)
    server = await startServer({ board: 'default' })
  } finally {
    other.kill()
  }
})

test('web preferences, custom moves and read queries share the authenticated socket', async () => {
  const card = await boardWithCard()
  const t = await tab(); await t.next()
  t.command('view-1', 'view', ['set', '--json', JSON.stringify({ customColumns: [{ id: 'custom:later', title: 'Later' }], panelWidth: 500 }), '--if-revision', '0', '--event-id', 'web-view'])
  const update = await t.next(); assert.equal(update.type, 'event')
  const receipt = await t.next(); assert.equal(receipt.type, 'receipt')
  assert.equal(loadBoard('default').state.view?.panelWidth, 500)
  t.command('move-1', 'move', [card, 'custom:later', '--if-revision', '1'])
  assert.equal((await t.next()).type, 'event'); assert.equal((await t.next()).type, 'receipt')
  assert.equal(loadBoard('default').state.cards[card]?.column, 'custom:later')
  t.command('view-stale', 'view', ['set', '--json', '{"fontSize":18}', '--if-revision', '0'])
  const stale = await t.next(); assert.equal(stale.type, 'error')

  if (stale.type === 'error') {
    assert.equal(stale.code, 'REVISION_CONFLICT')
  }

  t.command('thread-1', 'thread', [card])
  const thread = await t.next(); assert.equal(thread.type, 'receipt')

  if (thread.type === 'receipt') {
    assert.equal((thread.thread as { route: boolean }).route, false)
  }

  t.command('reply-1', 'reply', [card, 'test', 'id'])
  const reply = await t.next(); assert.equal(reply.type, 'error')

  if (reply.type === 'error') {
    assert.equal(reply.code, 'NO_ROUTE')
  }

  // A setting change takes the reply's route, so it is refused the same way.
  t.command('agent-1', 'agent', [card, 'effort', 'high', 'id'])
  const agent = await t.next(); assert.equal(agent.type, 'error')

  if (agent.type === 'error') {
    assert.equal(agent.code, 'NO_ROUTE')
  }

  t.command('agent-2', 'agent', [card, 'effort', 'high'])
  const short = await t.next(); assert.equal(short.type, 'error')

  if (short.type === 'error') {
    assert.equal(short.code, 'VALIDATION_ERROR')
  }

  t.command('history-1', 'history', ['--card', card]); assert.equal((await t.next()).type, 'receipt')
  t.command('escape-board', 'history', ['--board', 'other']); assert.equal((await t.next()).type, 'error')
  t.command('card-1', 'card', [card, '--full'])
  const shown = await t.next(); assert.equal(shown.type, 'receipt')

  if (shown.type === 'receipt') {
    assert.deepEqual(shown.notes, { summary: 'none', decisions: 'none', context: 'none' })
  }

  t.ws.close()
})

test("overlapping catalog requests share or queue the socket's read and answer each with its own card", async () => {
  const home = process.env.PNYX_HOME!, locations = { home, claude: join(home, 'claude'), codex: join(home, 'codex') }

  for (const key of ['one', 'two']) {
    const cwd = join(home, key); mkdirSync(join(cwd, '.git'), { recursive: true }); mkdirSync(join(cwd, '.claude/skills', `skill-${key}`), { recursive: true })
    writeFileSync(join(cwd, '.claude/skills', `skill-${key}`, 'SKILL.md'), `---\nname: skill-${key}\ndescription: ${key}\n---\n`)
    withWriter('default', w => {
      const d = decidePush(w.state, key, { title: key, agent: { provider: 'claude', sessionId: key, cwd } }, { actor: 'test', at: '2026-10-14T10:00:00Z' }); assert.ok('event' in d); w.append(d.event)
    })
  }

  const { one, two } = loadBoard('default').state.keys
  server = await startServer({ board: 'default', catalogLocations: locations })
  const t = await tab(); await t.next()
  const requests = [['c1', one], ['c2', one], ['c3', two], ['c4', one]] as const

  for (const [id, card] of requests) {
    t.command(id, 'catalog', [card!])
  }

  const replies = new Map<string, ServerMessage>()

  for (let n = 0; n < requests.length; n++) {
    const reply = await t.next(); replies.set((reply as { id: string }).id, reply)
  }

  for (const [id, card] of requests) {
    const reply = replies.get(id)!; assert.equal(reply.type, 'receipt', `${id}: ${JSON.stringify(reply)}`)
    const commands = (
      reply as unknown as { catalog: { suggestions: { command: string }[] } }
    ).catalog.suggestions.map(s => s.command)
    assert.deepEqual(commands, [card === one ? '/skill-one' : '/skill-two'])
  }

  t.ws.close()
})

test('browser reply delivery uses only configured fixture homes and never resends an unknown result', async () => {
  const fixture = seedWebFixture(process.env.PNYX_HOME!)
  server = await startServer({ board: 'default', homes: [fixture.nativeHome] })
  const t = await tab(); await t.next()
  const card = fixture.state.keys.layout!
  writeFileSync(join(fixture.nativeHome, 'send-exit'), '3')

  const receipt = async (id: string) => {
    for (;;) {
      const m = await t.next()

      if ((m.type === 'receipt' || m.type === 'error') && m.id === id) {
        return m
      }
    }
  }

  t.command('send-1', 'reply', [card, 'A literal fixture reply', 'unknown-reply'])
  const first = await receipt('send-1'); assert.equal(first.type, 'receipt')

  if (first.type === 'receipt') {
    assert.equal((first.reply as { state: string }).state, 'delivery_unknown')
  }

  t.command('send-2', 'reply', [card, 'A literal fixture reply', 'unknown-reply'])
  const second = await receipt('send-2'); assert.equal(second.type, 'receipt')

  if (second.type === 'receipt') {
    assert.equal((second.reply as { sent: boolean }).sent, false)
  }

  assert.equal(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8').match(/A literal fixture reply/g)?.length, 1)
  t.command('send-3', 'reply', [card, '   ', 'blank-reply'])
  const invalid = await receipt('send-3'); assert.equal(invalid.type, 'error')

  if (invalid.type === 'error') {
    assert.equal(invalid.code, 'VALIDATION_ERROR')
  }

  assert.equal(loadBoard('default').state.cards[card]?.attention.length, 1)

  // A setting change goes through the same worker: the command, then Enter for a confirmation.
  writeFileSync(join(fixture.nativeHome, 'send-exit'), '0')
  withWriter('default', w => {
    const d = decidePush(w.state, 'layout', { agent: { provider: 'claude-code', sessionId: 'fixture-layout' } }, { actor: 'test', at: '2026-10-14T17:00:00Z' }); assert.ok('event' in d); w.append(d.event)
  })
  t.command('agent-1', 'agent', [card, 'effort', 'high', 'effort-1'])
  const changed = await receipt('agent-1'); assert.equal(changed.type, 'receipt', JSON.stringify(changed))

  if (changed.type === 'receipt') {
    assert.equal((changed.agent as { sent: string }).sent, 'delivered')
  }

  assert.match(readFileSync(join(fixture.nativeHome, 'sent.log'), 'utf8'), /arg=\/effort high\n---\n[^]*arg=--key\narg=Enter\n---\n$/)
  t.command('search-1', 'search', ['conversation readable'])
  const found = await receipt('search-1'); assert.equal(found.type, 'receipt')

  if (found.type === 'receipt') {
    assert.equal((found.hits as { card: string }[])[0]?.card, card)
  }

  t.ws.close()
})

const assistantLine = (text: string, at: string) => JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } }) + '\n'

test('the board search finds a card by a word only its transcript holds, including words a live session just wrote', async () => {
  const fixture = seedWebFixture(process.env.PNYX_HOME!)
  server = await startServer({ board: 'default' })
  const t = await tab(); await t.next()

  const search = async (id: string, text: string) => {
    t.command(id, 'search', [text])

    for (;;) {
      const m = await t.next()

      if ((m.type === 'receipt' || m.type === 'error') && m.id === id) {
        return m
      }
    }
  }

  const cards = (m: ServerMessage) => (m.type === 'receipt' ? (m.hits as { card: string }[]).map(h => h.card) : m)
  // "readable" is only in the transcript's first user message, not in any title, link or event.
  assert.deepEqual(cards(await search('s1', 'readable')), [fixture.state.keys.layout])
  appendFileSync(fixture.transcript, assistantLine('The flamingo rollout is staged behind the flag.', '2026-10-13T11:00:00Z'))
  const byText = await search('s2', 'flamingo rollout')
  assert.deepEqual(cards(byText), [fixture.state.keys.layout])
  assert.equal(byText.type === 'receipt' && (byText.hits as { match: string }[])[0]!.match, 'lexical')
  assert.deepEqual(cards(await search('s3', 'flamingo nowhere')), [])
  t.ws.close()
})

test('a board search rebuilds a stale search index', async () => {
  const fixture = seedWebFixture(process.env.PNYX_HOME!)
  // An index another version left behind.
  writeFileSync(searchPath('default'), 'not a database')
  assert.equal(indexStatus('default')?.current, false)
  server = await startServer({ board: 'default' })
  const t = await tab(); await t.next()
  t.command('s1', 'search', ['readable'])
  let m = await t.next()

  while (!((m.type === 'receipt' || m.type === 'error') && m.id === 's1')) {
    m = await t.next()
  }

  assert.deepEqual(m.type === 'receipt' && (m.hits as { card: string }[]).map(h => h.card), [fixture.state.keys.layout])
  const status = indexStatus('default')
  assert.equal(status?.current, true)
  assert.equal(status?.transcripts.tracked, 1)
  t.ws.close()
})

test("each card gets its conversation's last message, pushed again as the transcript grows", async () => {
  const fixture = seedWebFixture(process.env.PNYX_HOME!)
  const card = fixture.state.keys.layout!
  server = await startServer({ board: 'default' })
  const t = await tab(); await t.next()
  assert.deepEqual(await t.latest(card), { role: 'assistant', text: 'The first pass is ready to review. Try resizing a column or switching the conversation to inline in Settings.', at: '2026-10-13T10:49:00Z' })
  // Tool calls and thinking never replace the last message; a newer typed user message does.
  appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-13T11:00:00Z', message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', name: 'Bash', input: {} }] } }) + '\n')
  appendFileSync(fixture.transcript, JSON.stringify({ type: 'user', timestamp: '2026-10-13T11:01:00Z', message: { content: 'Ship   it\nnow.' } }) + '\n')
  assert.deepEqual(await t.latest(card), { role: 'user', text: 'Ship it now.', at: '2026-10-13T11:01:00Z' })
  appendFileSync(fixture.transcript, assistantLine('Shipped.', '2026-10-13T11:02:00Z'))
  assert.deepEqual(await t.latest(card), { role: 'assistant', text: 'Shipped.', at: '2026-10-13T11:02:00Z' })
  // A tab that connects later gets every card's last message at once.
  const later = await tab(); await later.next()
  assert.deepEqual(await later.latest(card), { role: 'assistant', text: 'Shipped.', at: '2026-10-13T11:02:00Z' })
  // A tab that resyncs, such as one dropped while lagging, gets them again after its snapshot.
  t.ws.send(JSON.stringify({ type: 'resync' }))
  assert.equal((await t.next()).type, 'snapshot')
  assert.deepEqual(await t.latest(card), { role: 'assistant', text: 'Shipped.', at: '2026-10-13T11:02:00Z' })
  t.ws.close(); later.ws.close()
})

test("a tab whose snapshot alone fills its send buffer still gets every card's last message", async () => {
  const fixture = seedWebFixture(process.env.PNYX_HOME!)
  server = await startServer({ board: 'default' })
  const card = fixture.state.keys.layout!, message = { role: 'assistant', text: 'The first pass is ready to review. Try resizing a column or switching the conversation to inline in Settings.', at: '2026-10-13T10:49:00Z' }
  const first = await tab(); await first.next()
  assert.deepEqual(await first.latest(card), message)
  withWriter('default', w => {
    const d = decidePush(w.state, 'big', { title: 'x'.repeat(4 << 20) }, { actor: 'test', at: '2026-10-14T10:00:00Z' }); assert.ok('event' in d); w.append(d.event)
  })
  assert.equal((await first.next()).type, 'event')
  // The card's message is read already, so a later tab gets it only right after its snapshot.
  const t = await tab()
  assert.equal((await t.next()).type, 'snapshot')
  assert.deepEqual(await t.latest(card), message)
  first.ws.close(); t.ws.close()
})

test('with semantic search on, the board search finds a transcript-only card by meaning when its words do not all match', async () => {
  const fixture = seedWebFixture(process.env.PNYX_HOME!)
  appendFileSync(fixture.transcript, assistantLine('Flamingo rollout staged.', '2026-10-13T11:00:00Z'))
  // The stub worker embeds with hashed word vectors, so no model is fetched or loaded.
  delete process.env.PNYX_SEMANTIC
  process.env.PNYX_SEMANTIC_STUB = '1'
  writeSetting('search.rerank', 'off')

  try {
    server = await startServer({ board: 'default' })
    const t = await tab(); await t.next()
    // "dinosaur" is nowhere, so full text finds nothing; the transcript holds the other words.
    // The first search waits for the worker to start and embed the board, so receipts may be slow:
    // wait longer than the server's own worst case (10s index request plus 30s embed request).
    const deadline = Date.now() + 60_000

    const receipt = async (id: string): Promise<ServerMessage> => {
      for (;;) {
        try {
          const m = await t.next()

          if ((m.type === 'receipt' || m.type === 'error') && m.id === id) {
            return m
          }
        } catch (error) {
          if (Date.now() > deadline) {
            throw error
          }
        }
      }
    }

    let hits: { card: string; match: string; weak?: true }[] = []

    for (let n = 0; !hits.some(h => h.match === 'semantic') && Date.now() < deadline; n++) {
      t.command(`m${n}`, 'search', ['flamingo rollout staged dinosaur'])
      const m = await receipt(`m${n}`)
      assert.equal(m.type, 'receipt', JSON.stringify(m))
      hits = m.type === 'receipt' ? m.hits as typeof hits : []
    }

    assert.deepEqual(hits.filter(h => !h.weak).map(h => [h.card, h.match]), [[fixture.state.keys.layout, 'semantic']])
    t.ws.close()
  } finally {
    // Stops the worker for this home within seconds.
    writeSetting('search.semantic', 'off')
    process.env.PNYX_SEMANTIC = 'off'
    delete process.env.PNYX_SEMANTIC_STUB
  }
})

test('a stopped server leaves no open handles, even with board and transcript changes still in flight', async () => {
  const fixture = seedWebFixture(process.env.PNYX_HOME!)
  const card = fixture.state.keys.layout!
  const settle = () => new Promise(r => setTimeout(r, 300))
  // Resources this process held before the server, such as the test runner's own.
  await settle()
  const before = process.getActiveResourcesInfo().sort()
  server = await startServer({ board: 'default' })
  const t = await tab(); await t.next()
  assert.ok(await t.latest(card))
  t.command('thread-1', 'thread', [card])
  t.command('search-1', 'search', ['readable'])

  for (let n = 0; n < 2;) {
    const m = await t.next()

    if (m.type === 'receipt') {
      n++
    }
  }

  // Changes that land just before the stop schedule more work: a log append, a spool
  // drain and a transcript write that the folder watchers see.
  appendFileSync(fixture.transcript, assistantLine('Still writing.', '2026-10-13T11:05:00Z'))
  cli('move', card, 'review')
  await server.close()
  server = undefined
  await settle()
  assert.deepEqual(process.getActiveResourcesInfo().sort(), before)
})
