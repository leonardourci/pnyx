// Firstmate integration against a fixture home copied into a temp dir, with a fake
// fm-send. Never points at a real Firstmate home.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadBoard, readEvents, spoolWrite } from '../src/store/board-store.ts'
import { captainsIntent, homeKey, parseBacklog, resolveHome } from '../src/integrations/firstmate/home.ts'
import { latestActivity, openDecisions, parseStatusLine, statusNotes } from '../src/integrations/firstmate/status.ts'
import { syncHome, watchHome, type SyncResult } from '../src/integrations/firstmate/sync.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'firstmate-home')
const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')

function copyFixture(): { home: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'pnyx-fm-'))
  cpSync(FIXTURE, join(root, 'home'), { recursive: true })
  const env = { ...process.env, PNYX_HOME: join(root, 'pnyx') }
  process.env.PNYX_HOME = env.PNYX_HOME

  return { home: resolveHome(join(root, 'home')), env }
}

const cardOf = (home: string, task?: string) => {
  const { state } = loadBoard('default')

  return state.cards[state.keys[task ? `${homeKey(home)}:${task}` : homeKey(home)]!]!
}

test("status lines follow Firstmate's key grammar", () => {
  assert.deepEqual(parseStatusLine('needs-decision [key=api] [at=1]: pick one'), {
    verb: 'needs-decision',
    note: 'pick one',
    key: 'api',
    declares: true,
    colon: true,
  })
  // A readable stamp with colons does not move the head/note boundary.
  assert.equal(parseStatusLine('blocked [at=10:30]: stuck').note, 'stuck')
  // A key at the head of the note is the same key, stripped from the note.
  assert.deepEqual([parseStatusLine('resolved: [key=api] REST').key, parseStatusLine('resolved: [key=api] REST').note], ['api', 'REST'])
  assert.equal(parseStatusLine('needs-decision: plain').key, 'default')
  assert.equal(parseStatusLine('needs-decision [key=a b]: x').key, null)
  assert.equal(parseStatusLine('resolved corr=0123456789abcdef [key=k]: ok').verb, 'resolved')
  assert.equal(parseStatusLine('just prose').declares, false)
})

test('the decision fold opens, closes and clears keys like Firstmate', () => {
  const log = [
    'needs-decision [key=a]: first',
    'blocked [key=b]: second',
    'working: unrelated progress',
    'resolved [key=a]: answered',
    "needs-decision [key=pending-reply-x]: not in the owner's vocabulary",
    'needs-decision [key=pending-reply-y]: pending-reply-missed: owner wrote this',
    'needs-decision: keyless uses default',
  ].join('\n')
  assert.deepEqual(
    openDecisions(log, 'ship').map(d => d.key),
    ['b', 'pending-reply-y', 'default'],
  )
  // A ship or scout terminal line closes every decision; a secondmate's does not.
  assert.deepEqual(openDecisions(`${log}\ndone: shipped`, 'ship'), [])
  assert.equal(openDecisions(`${log}\ndone: other work`, 'secondmate').length, 3)
  assert.deepEqual(openDecisions('needs-decision [key=k]: x\ncaptain-held [key=k]: moved to captain', 'ship'), [])
  assert.equal(latestActivity('working: a\ncontinuation prose\n'), 'working: a')
})

test('decisions, answers and reports in a status log become notes', () => {
  const log = [
    'working [at=1791900000]: setup done',
    'needs-decision [key=api] [at=1791900100]: REST or RPC?',
    'resolved [key=api] [at=1791900200]: REST, the captain said keep it boring',
    'needs-decision: which docs first?',
    'done [at=1791900300]: PR https://github.com/example/app/pull/41 checks green',
    'done:',
    'needs-decision [key=bad slug]: malformed keys move nothing',
  ].join('\n')
  assert.deepEqual(
    statusNotes(log).map(({ kind, text, at }) => ({ kind, text, at })),
    [
      { kind: 'decision', text: 'needs-decision [api]: REST or RPC?', at: '2026-10-13T14:01:40.000Z' },
      { kind: 'decision', text: 'resolved [api]: REST, the captain said keep it boring', at: '2026-10-13T14:03:20.000Z' },
      { kind: 'decision', text: 'needs-decision: which docs first?', at: undefined },
      { kind: 'summary', text: 'done: PR https://github.com/example/app/pull/41 checks green', at: '2026-10-13T14:05:00.000Z' },
    ],
  )
  const brief = readFileSync(join(FIXTURE, 'data', 'api-v2', 'brief.md'), 'utf8')
  assert.equal(captainsIntent(brief), 'Ship the v2 API so partners can page through invoices.\nKeep v1 working until every partner moves.')
  assert.equal(captainsIntent('# Task\nno intent here'), undefined)
})

test('backlog rows give titles, repo tags and merged state', () => {
  const rows = parseBacklog(readFileSync(join(FIXTURE, 'data', 'backlog.md'), 'utf8'))
  assert.deepEqual(rows.get('api-v2'), { title: 'app: v2 API with (optional) pagination', repo: 'app', done: false, merged: false })
  assert.deepEqual(rows.get('release-1'), {
    title: 'app: cut release 1 https://github.com/example/app/pull/40',
    repo: 'app',
    done: true,
    merged: true,
  })
  assert.equal(rows.get('later-1')?.merged, false)
  assert.deepEqual(rows.get('docs-scout'), { title: 'app: survey the docs', repo: 'docs', done: true, merged: false })
})

test("sync turns each task into a card under the home's card", () => {
  const { home } = copyFixture()
  const result = syncHome('default', home, '2026-10-13T10:00:00.000Z')
  assert.equal(result.tasks, 4)

  const parent = cardOf(home)
  assert.equal(parent.tags[0], 'firstmate')
  const api = cardOf(home, 'api-v2')
  assert.equal(api.title, 'app: v2 API with (optional) pagination')
  assert.deepEqual(api.tags, ['app'])
  assert.equal(api.parentId, parent.id)
  assert.deepEqual(
    api.attention.map(a => [a.kind, a.key, a.blocking]),
    [
      ['needs-decision', 'api-shape', true],
      ['blocked', 'ci-token', true],
    ],
  )
  assert.equal(api.column, 'needs_you')
  assert.equal(api.activity, 'working: PR https://github.com/example/app/pull/41 opened')
  // A pull request named only in the status log is not the task's own.
  assert.deepEqual(api.links, [])
  assert.deepEqual(api.sourceRefs, [{ adapter: 'firstmate', instanceId: home, objectId: 'api-v2' }])

  // The scout's terminal line closed its decision, and its Done backlog row
  // records it as done with no pull request.
  const scout = cardOf(home, 'docs-scout')
  assert.deepEqual(scout.attention, [])
  assert.deepEqual(scout.outcome, { state: 'done', source: 'firstmate' })
  assert.equal(scout.column, 'done')
  // A failed: line closes the ship's decisions but asks for the owner.
  const hotfix = cardOf(home, 'hotfix-2')
  assert.deepEqual(hotfix.attention, [{ kind: 'failed', key: '@status', blocking: true, text: 'tests red after patch' }])
  assert.equal(hotfix.outcome, undefined)
  assert.equal(hotfix.column, 'needs_you')
  // meta pr= plus a merged backlog row: Done.
  const release = cardOf(home, 'release-1')
  assert.deepEqual(release.links.map(l => [l.number, l.state]), [[40, 'merged']])
  assert.equal(release.column, 'done')

  assert.deepEqual(syncHome('default', home), { tasks: 4, appended: 0 })
})

test('a failed task closed in the backlog lands in Done as a closed failure', () => {
  const { home } = copyFixture()
  syncHome('default', home)
  assert.equal(cardOf(home, 'hotfix-2').column, 'needs_you')
  const backlog = join(home, 'data', 'backlog.md')
  const rows = readFileSync(backlog, 'utf8').split('\n')
  const [row] = rows.splice(rows.findIndex(l => l.startsWith('- [ ] hotfix-2')), 1)
  rows.splice(rows.indexOf('## Done') + 1, 0, row!.replace('[ ]', '[x]'))
  writeFileSync(backlog, rows.join('\n'))
  syncHome('default', home)
  const hotfix = cardOf(home, 'hotfix-2')
  assert.deepEqual(hotfix.attention, [])
  assert.deepEqual(hotfix.outcome, { state: 'failed', note: 'closed after failure', closed: true, source: 'firstmate' })
  assert.equal(hotfix.column, 'done')
})

test('a blocked task closed in the backlog leaves Needs you', () => {
  const { home } = copyFixture()
  writeFileSync(join(home, 'state', 'hotfix-2.status'), 'working: reproducing\nblocked: waiting for CI token\n')
  syncHome('default', home)
  assert.deepEqual(cardOf(home, 'hotfix-2').attention.map(a => [a.kind, a.key]), [['blocked', 'default']])
  assert.equal(cardOf(home, 'hotfix-2').column, 'needs_you')
  const backlog = join(home, 'data', 'backlog.md')
  const rows = readFileSync(backlog, 'utf8').split('\n')
  const [row] = rows.splice(rows.findIndex(l => l.startsWith('- [ ] hotfix-2')), 1)
  rows.splice(rows.indexOf('## Done') + 1, 0, row!.replace('[ ]', '[x]'))
  writeFileSync(backlog, rows.join('\n'))
  syncHome('default', home)
  const hotfix = cardOf(home, 'hotfix-2')
  assert.deepEqual(hotfix.attention, [])
  assert.deepEqual(hotfix.outcome, { state: 'done', source: 'firstmate' })
  assert.equal(hotfix.column, 'done')
})

test('a done: status line alone is not completion', () => {
  const { home } = copyFixture()
  const backlog = join(home, 'data', 'backlog.md')
  const rows = readFileSync(backlog, 'utf8').split('\n')
  const scout = rows.findIndex(l => l.startsWith('- [x] docs-scout'))
  const [row] = rows.splice(scout, 1)
  rows.splice(rows.indexOf('## In flight') + 1, 0, row!.replace('[x]', '[ ]'))
  writeFileSync(backlog, rows.join('\n'))
  syncHome('default', home)
  assert.equal(cardOf(home, 'docs-scout').outcome, undefined)
  assert.equal(cardOf(home, 'docs-scout').column, 'workers_on_it')
})

test('sync never overwrites a link state another source refreshed', () => {
  const { home } = copyFixture()
  appendFileSync(join(home, 'state', 'api-v2.meta'), 'pr=https://github.com/example/app/pull/41\n')
  syncHome('default', home)
  assert.equal(cardOf(home, 'api-v2').links[0]!.state, 'open')
  const api = cardOf(home, 'api-v2')
  execFileSync(process.execPath, [BIN, 'link', api.id, '--url', 'https://github.com/example/app/pull/41', '--state', 'closed'], {
    env: process.env,
  })
  appendFileSync(join(home, 'state', 'api-v2.status'), 'working: still going\n')
  syncHome('default', home)
  assert.equal(cardOf(home, 'api-v2').links[0]!.state, 'closed')
})

test('a task whose records are gone drops its open decisions', () => {
  const { home } = copyFixture()
  syncHome('default', home)
  rmSync(join(home, 'state', 'api-v2.meta'))
  rmSync(join(home, 'state', 'api-v2.status'))
  syncHome('default', home)
  const api = cardOf(home, 'api-v2')
  assert.deepEqual(api.attention, [])
  assert.equal(api.title, 'app: v2 API with (optional) pagination')
})

test('watch reconciles on start and folds each change', async () => {
  const { home } = copyFixture()
  const results: SyncResult[] = []
  let wake: () => void = () => {}
  const watcher = watchHome('default', home, r => {
    if (r instanceof Error) {
      throw r
    }

    results.push(r)
    wake()
  })

  try {
    assert.equal(results[0]!.tasks, 4)
    const changed = new Promise<void>(resolve => (wake = resolve))
    appendFileSync(join(home, 'state', 'api-v2.status'), 'resolved [key=api-shape]: REST\n')
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('no sync after change')), 5000))])
    assert.deepEqual(cardOf(home, 'api-v2').attention.map(a => a.key), ['ci-token'])
  } finally {
    watcher.close()
  }
})

function cli(env: NodeJS.ProcessEnv) {
  const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
  const fails = (args: string[], code: string) =>
    assert.throws(() => run(...args), (error: { stdout: string }) => {
      assert.match(error.stdout, new RegExp(`^code: ${code}$`, 'm'))

      return true
    })

  return { run, fails }
}

test('firstmate sync through the CLI', () => {
  const { home, env } = copyFixture()
  const { run, fails } = cli(env)
  assert.match(run('firstmate', 'sync', '--home', home), /home,4,13$/m)
  assert.match(run(), /needs_you: 2/)
  fails(['firstmate', 'sync'], 'VALIDATION_ERROR')
  fails(['firstmate', 'sync', '--home', join(home, 'data')], 'VALIDATION_ERROR')
})

test('serve --home folds the home into the board without a separate watch', async () => {
  const { home, env } = copyFixture()
  const server = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--home', home], { env, stdio: ['ignore', 'pipe', 'inherit'] })

  try {
    let out = ''
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not start: ${out}`)), 10000)
      server.stdout.on('data', (chunk: Buffer) => {
        out += chunk

        if (out.includes('help[1]')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    assert.match(out, /^firstmate: "watching 1 home"$/m)
    assert.equal(cardOf(home, 'api-v2').title, 'app: v2 API with (optional) pagination')
  } finally {
    const exited = new Promise(resolve => server.once('exit', resolve))
    server.kill('SIGTERM')
    await exited
  }
})

test('a Firstmate outcome is a source observation: undo and clear refuse it', () => {
  const { home, env } = copyFixture()
  const { run, fails } = cli(env)
  run('firstmate', 'sync', '--home', home)
  const scout = cardOf(home, 'docs-scout')
  const recorded = readEvents('default').find(e => e.type === 'card.outcome' && e.cardId === scout.id)!
  fails(['undo', recorded.id], 'NOT_UNDOABLE')
  fails(['outcome', scout.id, '--clear'], 'SOURCE_OWNED')
  fails(['outcome', scout.id, 'cancelled'], 'SOURCE_OWNED')
  run('move', scout.id, 'needs_you')
  run('firstmate', 'sync', '--home', home)
  assert.deepEqual(cardOf(home, 'docs-scout').outcome, { state: 'done', source: 'firstmate' })
  assert.equal(cardOf(home, 'docs-scout').column, 'needs_you')
})

test("a task's decisions, reports and Captain's intent show on its card", () => {
  const { home, env } = copyFixture()
  const { run, fails } = cli(env)
  run('firstmate', 'sync', '--home', home)
  const api = run('card', cardOf(home, 'api-v2').id)
  assert.match(api, /^ {2}decisions\[1\]\{at,source,text\}:\n {4}"2026-10-13T14:01:40.000Z",firstmate,"needs-decision \[api-shape\]: REST or RPC for the v2 endpoints\?"$/m)
  assert.match(api, /^ {2}context\[1\]\{at,source,text\}:\n {4}"[^"]+",firstmate,"Captain's intent:\\nShip the v2 API so partners can page through invoices\.\\nKeep v1 working until every partner moves\."$/m)
  assert.doesNotMatch(api, /Firstmate spec|Setup text/)
  assert.match(run('card', cardOf(home, 'release-1').id), /^ {2}summary\[1\]\{at,source,text\}:\n {4}"2026-10-13T14:06:40.000Z",firstmate,"done: PR https:\/\/github.com\/example\/app\/pull\/40 checks green"$/m)
  // New lines add notes; a re-sync adds nothing twice.
  appendFileSync(join(home, 'state', 'api-v2.status'), 'resolved [key=api-shape] [at=1791900700]: REST\n')
  assert.match(run('firstmate', 'sync', '--home', home), /home,4,2$/m)
  assert.match(run('firstmate', 'sync', '--home', home), /home,4,0$/m)
  assert.match(run('search', 'partners', 'page'), /^ {6}note,"[^"]+","…Ship the v2 API so \[partners\] can \[page\]/m)
  fails(['undo', readEvents('default').find(e => e.type === 'card.noted')!.id], 'NOT_UNDOABLE')
})

test('a Firstmate outcome follows the backlog on every sync', () => {
  const { home } = copyFixture()
  syncHome('default', home)
  assert.deepEqual(cardOf(home, 'docs-scout').outcome, { state: 'done', source: 'firstmate' })
  // A later failed: line turns the recorded done into a closed failure.
  appendFileSync(join(home, 'state', 'docs-scout.status'), 'failed: rerun broke\n')
  syncHome('default', home)
  assert.deepEqual(cardOf(home, 'docs-scout').outcome, { state: 'failed', note: 'closed after failure', closed: true, source: 'firstmate' })
  // Back in flight: the outcome is cleared.
  const backlog = join(home, 'data', 'backlog.md')
  const rows = readFileSync(backlog, 'utf8').split('\n')
  const [row] = rows.splice(rows.findIndex(l => l.startsWith('- [x] docs-scout')), 1)
  rows.splice(rows.indexOf('## In flight') + 1, 0, row!.replace('[x]', '[ ]'))
  writeFileSync(backlog, rows.join('\n'))
  syncHome('default', home)
  assert.equal(cardOf(home, 'docs-scout').outcome, undefined)
  assert.notEqual(cardOf(home, 'docs-scout').column, 'done')
  const cleared = readEvents('default').filter(e => e.type === 'card.outcome')
    .at(-1)!
  cli(process.env).fails(['undo', cleared.id], 'NOT_UNDOABLE')
  assert.deepEqual(syncHome('default', home).appended, 0)
})

test('firstmate sync ingests the hook spool', () => {
  const { home } = copyFixture()
  spoolWrite('default', { id: 's1', key: 'spooled', at: '2026-01-01T00:00:00.000Z', card: { title: 'from a hook' } })
  syncHome('default', home)
  assert.equal(loadBoard('default').state.cards[loadBoard('default').state.keys['spooled']!]!.title, 'from a hook')
})

test("reply sends through the home's fm-send with FM_HOME and records receipts", () => {
  const { home, env } = copyFixture()
  const { run, fails } = cli(env)
  run('firstmate', 'sync', '--home', home)
  const api = cardOf(home, 'api-v2')
  const sent = () => (existsSync(join(home, 'sent.log')) ? readFileSync(join(home, 'sent.log'), 'utf8') : '')

  const out = run('reply', api.id, '--text', 'Use REST', '--resolve-key', 'api-shape', '--idempotency-key', 'k1', '--home', home)
  assert.match(out, /state: delivered/)
  assert.equal(sent(), `FM_HOME=${home}\narg=api-v2\narg=--resolve-key\narg=api-shape\narg=Use REST\n---\n`)
  // A retry with the same key does not send again.
  assert.match(run('reply', api.id, '--text', 'Use REST', '--idempotency-key', 'k1', '--home', home), /sent: false/)
  assert.equal(sent().split('---').length, 2)
  // The answer does not close the decision by itself; Firstmate's resolved line does.
  assert.equal(cardOf(home, 'api-v2').attention.length, 2)

  writeFileSync(join(home, 'send-exit'), '2')
  assert.match(run('reply', api.id, '--text', 'ping', '--idempotency-key', 'k2', '--home', home), /state: failed/)
  writeFileSync(join(home, 'send-exit'), '0')
  assert.match(run('reply', api.id, '--text', 'ping', '--idempotency-key', 'k2', '--home', home), /state: delivered/)
  writeFileSync(join(home, 'send-exit'), '3')
  assert.match(run('reply', api.id, '--text', 'maybe', '--idempotency-key', 'k3', '--home', home), /state: delivery_unknown/)
  assert.match(run('reply', api.id, '--text', 'maybe', '--idempotency-key', 'k3', '--home', home), /sent: false/)
  // Exit 1 (a remote send that lost its transport) may also have landed.
  writeFileSync(join(home, 'send-exit'), '1')
  const unknown = run('reply', api.id, '--text', 'remote', '--idempotency-key', 'k4', '--home', home)
  assert.match(unknown, /state: delivery_unknown/)
  assert.match(unknown, /may have landed/)
  assert.doesNotMatch(unknown, /retry with --idempotency-key/)
  assert.match(run('reply', api.id, '--text', 'remote', '--idempotency-key', 'k4', '--home', home), /sent: false/)

  const history = run('history', '--card', api.id, '--kind', 'replied', '--limit', '100')
  assert.equal(history.match(/reply k2 /g)?.length, 4)
  assert.match(history, /reply k1 delivered/)
  assert.match(history, /reply k3 delivery_unknown/)

  // The send went through but its outcome could not be recorded: the receipt still
  // names the reply, and a retry finds it queued and does not resend.
  writeFileSync(join(home, 'send-exit'), '0')
  writeFileSync(join(home, 'tear'), '')
  const unrecorded = run('reply', api.id, '--text', 'torn', '--home', home)
  assert.match(unrecorded, /state: delivered/)
  assert.match(unrecorded, /recordError: /)
  const id = /reply: (r\d+)/.exec(unrecorded)![1]!
  rmSync(join(home, 'tear'))
  run('repair')
  const retry = run('reply', api.id, '--text', 'torn', '--idempotency-key', id, '--home', home)
  assert.match(retry, /state: queued/)
  assert.match(retry, /sent: false/)
  assert.match(retry, /Check the task's inbox/)
  assert.equal(sent().split('---').length - 1, 6)
  // A known failure that could not be recorded says nothing was delivered.
  writeFileSync(join(home, 'send-exit'), '2')
  writeFileSync(join(home, 'tear'), '')
  const lost = run('reply', api.id, '--text', 'lost', '--home', home)
  assert.match(lost, /state: failed/)
  assert.match(lost, /nothing was delivered/)
  rmSync(join(home, 'tear'))
  run('repair')

  fails(['reply', api.id, '--text', 'x', '--resolve-key', 'nope', '--home', home], 'VALIDATION_ERROR')
  // A failed: line's attention is not a Firstmate decision fm-send could resolve.
  fails(['reply', cardOf(home, 'hotfix-2').id, '--text', 'x', '--resolve-key', '@status', '--home', home], 'VALIDATION_ERROR')
  fails(['reply', api.id, '--text=--resolve-key x', '--home', home], 'VALIDATION_ERROR')
  fails(['reply', cardOf(home).id, '--text', 'x', '--home', home], 'NO_ROUTE')
  // A task id that is not Firstmate's would reach fm-send as an option.
  const crafted = join(home, 'crafted.json')
  writeFileSync(crafted, JSON.stringify({ title: 'crafted', source: { adapter: 'firstmate', instanceId: home, objectId: '--resolve-key' } }))
  run('push', '--key', 'crafted', '--file', crafted)
  fails(['reply', 'crafted', '--text', 'x', '--home', home], 'NO_ROUTE')
  fails(['undo', readEvents('default').find(e => e.type === 'card.replied')!.id], 'NOT_UNDOABLE')
  // The card's home must be configured for this send.
  const other = copyFixture()
  fails(['reply', api.id, '--text', 'x', '--home', other.home], 'VALIDATION_ERROR')
})

test("a hook session in a task's worktree joins the task card, which keeps fm-send", () => {
  const { home, env } = copyFixture()
  const worktree = mkdtempSync(join(tmpdir(), 'pnyx-wt-'))
  const meta = join(home, 'state', 'api-v2.meta')
  writeFileSync(meta, readFileSync(meta, 'utf8').replace(/^worktree=.*$/m, `worktree=${worktree}`))
  syncHome('default', home)
  const hook = (id: string, event: string, payload: Record<string, unknown>, extra = {}) =>
    spoolWrite('default', { v: 1, id, at: '2026-10-14T00:00:00Z', harness: 'claude', event, payload, ...extra })
  const terminal = { tty: '/dev/ttys042', pid: '4242', program: 'tmux', tmux: '/tmp/tmux-1/default', tmuxPane: '%3' }
  // The hook reports the folder as the session saw it; the join compares canonical paths.
  hook('h1', 'SessionStart', { session_id: 'fm-s', cwd: worktree, transcript_path: '/x/fm-s.jsonl' }, { terminal })
  hook('h2', 'SubagentStart', { session_id: 'fm-s', agent_id: 'a1', cwd: worktree })
  syncHome('default', home)
  const { state } = loadBoard('default')
  const api = cardOf(home, 'api-v2')
  assert.equal(api.folder, realpathSync(worktree))
  assert.equal(api.agent?.sessionId, 'fm-s')
  assert.deepEqual(api.terminal, terminal)
  assert.equal(state.keys['claude:fm-s'], undefined)
  assert.equal(state.cards[state.keys['claude:fm-s/a1']!]!.parentId, api.id)

  // The joined card still replies through Firstmate, never by typing into the pane.
  const { run } = cli(env)
  assert.match(run('reply', api.id, '--text', 'Use REST', '--home', home), /state: delivered/)
  assert.match(readFileSync(join(home, 'sent.log'), 'utf8'), /arg=api-v2\narg=Use REST/)

  // A closed task gives its worktree up, so the next session there keeps its own card.
  const backlog = join(home, 'data', 'backlog.md')
  const rows = readFileSync(backlog, 'utf8').split('\n')
  const [row] = rows.splice(rows.findIndex(l => l.startsWith('- [ ] api-v2')), 1)
  writeFileSync(backlog, [...rows, row!.replace('[ ]', '[x]')].join('\n'))
  syncHome('default', home)
  assert.equal(cardOf(home, 'api-v2').folder, undefined)
  hook('h3', 'SessionStart', { session_id: 'next', cwd: worktree })
  syncHome('default', home)
  assert.ok(loadBoard('default').state.keys['claude:next'])
})
