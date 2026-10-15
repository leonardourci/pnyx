import { fixtureCli } from './cli-fixture.ts'
// Harvested notes: summaries, decisions and context that transcripts and linked
// pull requests already hold, folded into cards and search. Fixtures and a temp
// PNYX_HOME only; gh-axi is a fake.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codexThreadTitle, transcriptNotes } from '../src/integrations/hooks/notes.ts'
import { transcriptMessages } from '../src/oracle/text.ts'
import { loadHydra, readEvents, spoolWrite } from '../src/store/hydra-store.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')
const FIXTURES = join(import.meta.dirname, 'fixtures')
const CLAUDE = join(FIXTURES, 'transcripts', 'claude-notes.jsonl')
const CODEX = join(FIXTURES, 'transcripts', 'codex-notes.jsonl')
const GH_AXI = join(FIXTURES, 'github', 'gh-axi.sh')

const records = ({ path }: { path: string }) => readFileSync(path, 'utf8').split('\n')
  .slice(0, -1)
  .map(l => JSON.parse(l) as unknown)

test('a Claude Code transcript yields its titles, compaction summaries and answered questions', () => {
  const notes = records({ path: CLAUDE }).flatMap(record => transcriptNotes({ record }))
  assert.deepEqual(
    notes.map(({ kind, source, text, at }) => ({ kind, source, text, ...(at ? { at } : {}) })),
    [
      { kind: 'context', source: 'claude-code', text: 'Session title: Nightly invoice export' },
      { kind: 'context', source: 'claude-code', text: 'Session title: Nightly invoice export' },
      { kind: 'decision', source: 'claude-code', text: 'Which time window should the batch use?\nAnswer: 2am UTC', at: '2026-10-11T09:02:00.000Z' },
      {
        kind: 'decision',
        source: 'claude-code',
        text: 'Keep the on-demand export?\nAnswer: No, batch only\nNotes: partners never used it',
        at: '2026-10-11T09:02:00.000Z',
      },
      {
        kind: 'summary',
        source: 'claude-code',
        text: '1. Primary Request and Intent: move the invoice export to a nightly batch at 2am UTC; the zebrafish pipeline stalled overnight.\n2. Pending: drop the on-demand export once partners confirm; the old cron job stays until the first nightly batch has run cleanly for a full week, then it goes along with its alerting rules.',
        at: '2026-10-11T10:00:01.000Z',
      },
      { kind: 'context', source: 'claude-code', text: 'Session title: Invoice batch rollout' },
      { kind: 'summary', source: 'claude-code', text: 'Invoice export moved to a nightly batch' },
    ],
  )
  assert.equal(notes[0]!.ref, notes[1]!.ref)
  assert.equal(new Set(notes.map(n => n.ref)).size, notes.length - 1)
  assert.ok(!records({ path: CLAUDE }).flatMap(record => transcriptMessages({ record }))
    .some(m => m.text.includes('zebrafish')))
})

test('a Codex transcript yields its readable compaction summaries', () => {
  assert.deepEqual(
    records({ path: CODEX }).flatMap(record => transcriptNotes({ record }))
      .map(({ kind, source, text, at }) => ({ kind, source, text, at })),
    [{ kind: 'summary', source: 'codex', text: 'The ledger sync drifts because rounding happens before currency conversion.', at: '2026-10-12T11:00:00.000Z' }],
  )
})

function hydraId() {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-notes-'))
  process.env.PNYX_HOME = home
  const env = { ...process.env, PNYX_HOME: home, PNYX_GH_AXI: GH_AXI }
  const run = fixtureCli({ home, execute: ({ args }) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) })
  const fails = ({ args, code }: { args: string[]; code: string }) =>
    assert.throws(() => run({ args: [...args] }), (error: { stdout: string }) => {
      assert.match(error.stdout, new RegExp(`^code: ${code}$`, 'm'))

      return true
    })

  const push = ({ key, card }: { key: string; card: object }) => {
    const file = join(home, 'card.json')
    writeFileSync(file, JSON.stringify(card))
    run({ args: ['push', '--key', key, '--file', file] })
  }

  const transcript = ({ name, from }: { name: string; from: string }) => {
    const path = join(home, name)
    copyFileSync(from, path)

    return path
  }

  return { home, run, fails, push, transcript }
}

const noted = () => readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.noted')

test('harvest folds transcript notes and pull requests into cards once', () => {
  const { run, fails, push, transcript } = hydraId()
  push({ key: 'claude:s1', card: { title: 'Invoices', agent: { provider: 'claude-code', sessionId: 's1', transcriptPath: transcript({ name: 's1.jsonl', from: CLAUDE }) } } })
  push({ key: 'codex:x2', card: { title: 'Ledger', agent: { provider: 'codex', sessionId: 'x2', transcriptPath: transcript({ name: 'x2.jsonl', from: CODEX }) } } })
  run({ args: ['link', 'c1', '--url', 'https://github.com/o/r/pull/42'] })
  run({ args: ['link', 'c1', '--url', 'https://github.com/o/r/pull/7'] })
  assert.match(run({ args: ['card', 'c1'] }), /^ {2}summary: none$/m)

  const out = run({ args: ['harvest'] })
  assert.match(out, /^ {2}notes: 8 new$/m)
  assert.match(out, /^ {2}pullRequests: 1$/m)
  assert.match(out, /^unread\[1\]: "https:\/\/github.com\/o\/r\/pull\/7"$/m)
  assert.match(run({ args: ['harvest'] }), /^ {2}notes: "none: nothing new"$/m)
  assert.equal(noted().length, 8)
  assert.ok(noted().every(e => e.actor === 'harvest'))

  const card = run({ args: ['card', 'c1'] })
  assert.match(card, /^notes:\n {2}summary\[2\]\{at,source,text\}:$/m)
  assert.match(card, /^ {2}decisions\[2\]\{at,source,text\}:\n {4}"2026-10-11T09:02:00.000Z",claude-code,"Which time window/m)
  assert.match(card, /^ {2}context\[3\]\{at,source,text\}:$/m)
  assert.match(card, /github,"Pull request #42: Nightly invoice export\\n\\nMoves the invoice export to a 2am UTC batch\."$/m)
  assert.doesNotMatch(card, /pipelineevidenceword|templatemarkerword/)
  assert.match(card, /pnyx-axi card c1 --full/)
  const full = run({ args: ['card', 'c1', '--full'] })
  assert.match(full, /Pending: drop the on-demand export/)
  assert.doesNotMatch(full, /--full/)
  assert.match(run({ args: ['card', 'c2'] }), /^ {2}summary\[1\]\{at,source,text\}:\n {4}"2026-10-12T11:00:00.000Z",codex,The ledger sync drifts/m)
  assert.match(run({ args: ['history', '--kind', 'noted', '--card', 'c2'] }), /summary from codex/)

  fails({ args: ['undo', noted()[0]!.id], code: 'NOT_UNDOABLE' })
  fails({ args: ['harvest', '--card', 'nope'], code: 'NOT_FOUND' })
})

test('harvest reads only what a transcript gained, and a lost cursor appends nothing twice', () => {
  const { home, run, push } = hydraId()
  const path = join(home, 's1.jsonl')
  writeFileSync(path, '')
  push({ key: 'claude:s1', card: { agent: { provider: 'claude-code', sessionId: 's1', transcriptPath: path } } })
  assert.match(run({ args: ['harvest'] }), /none: nothing new/)
  appendFileSync(path, readFileSync(CLAUDE, 'utf8'))
  assert.match(run({ args: ['harvest', '--card', 'claude:s1'] }), /^ {2}notes: 6 new$/m)
  appendFileSync(path, `${JSON.stringify({ type: 'custom-title', customTitle: 'Renamed', sessionId: 's1' })}\n`)
  assert.match(run({ args: ['harvest'] }), /^ {2}notes: 1 new$/m)
  writeFileSync(join(home, 'boards', 'default', 'harvest.json'), 'not json')
  assert.match(run({ args: ['harvest'] }), /none: nothing new/)
  assert.equal(noted().length, 7)
})

for (const event of ['Stop', 'PostCompact']) {
  test(`a session is harvested when its ${event} hook event is ingested`, () => {
    const { run, transcript } = hydraId()
    const path = transcript({ name: 's9.jsonl', from: CLAUDE })
    const payload = { session_id: 's9', transcript_path: path, cwd: '/work' }
    spoolWrite({ hydraId: 'default', entry: { v: 1, id: 'h0', at: '2026-10-11T10:59:00.000Z', harness: 'claude', event: 'SessionStart', payload } })
    spoolWrite({ hydraId: 'default', entry: { v: 1, id: 'h1', at: '2026-10-11T11:00:00.000Z', harness: 'claude', event, payload } })
    writeFileSync(join(process.env.PNYX_HOME!, 'other.json'), '{}')
    assert.match(run({ args: ['push', '--key', 'other', '--file', join(process.env.PNYX_HOME!, 'other.json')] }), /^ {2}notes: 6$/m)
    const { state } = loadHydra({ hydraId: 'default' })
    assert.equal(state.cards[state.keys['claude:s9']!]!.notes?.length, 6)
  })
}

test('search finds notes and ranks them above the same words in a transcript', () => {
  const { home, run, push } = hydraId()
  const raw = join(home, 'raw.jsonl')
  const summary = join(home, 'summary.jsonl')
  const text = 'Zebrafish pipeline stalled overnight.'
  writeFileSync(raw, `${JSON.stringify({ type: 'user', timestamp: '2026-10-11T09:00:00.000Z', message: { content: text } })}\n`)
  writeFileSync(summary, `${JSON.stringify({ type: 'user', isCompactSummary: true, uuid: 'z1', message: { content: text } })}\n`)
  push({ key: 'claude:raw', card: { title: 'First', agent: { provider: 'claude-code', sessionId: 'raw', transcriptPath: raw } } })
  push({ key: 'claude:sum', card: { title: 'Second', agent: { provider: 'claude-code', sessionId: 'sum', transcriptPath: summary } } })
  run({ args: ['harvest'] })
  const cards = ({ out }: { out: string }) => [...out.matchAll(/^ {2}- card: (\S+)$/gm)].map(m => m[1])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'zebrafish', 'pipeline'] }) }), ['c2', 'c1'])
  assert.match(run({ args: ['oracle', 'zebrafish', '--kind', 'note'] }), /^ {6}note,"[^"]+","\[Zebrafish\] pipeline stalled overnight\."$/m)
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'zebrafish', '--kind', 'transcript'] }) }), ['c1'])
  assert.match(run({ args: ['oracle', 'status'] }), /^ {2}note: 1$/m)
})

test('a harvested note neither reorders cards nor changes when they were updated', () => {
  const { run, push, transcript } = hydraId()
  push({ key: 'claude:s1', card: { title: 'Invoices', agent: { provider: 'claude-code', sessionId: 's1', transcriptPath: transcript({ name: 's1.jsonl', from: CLAUDE }) } } })
  push({ key: 'other', card: { title: 'Other' } })
  const before = loadHydra({ hydraId: 'default' }).state.cards[loadHydra({ hydraId: 'default' }).state.keys['claude:s1']!]!
  assert.match(run({ args: ['harvest'] }), /^ {2}notes: 6 new$/m)
  const after = loadHydra({ hydraId: 'default' }).state.cards[loadHydra({ hydraId: 'default' }).state.keys['claude:s1']!]!
  assert.equal(after.notes?.length, 6)
  assert.equal(after.revision, before.revision + 6)
  assert.equal(after.updatedSeq, before.updatedSeq)
  assert.equal(after.updatedAt, before.updatedAt)
  assert.ok(after.updatedSeq < loadHydra({ hydraId: 'default' }).state.cards[loadHydra({ hydraId: 'default' }).state.keys.other!]!.updatedSeq)
})

test('building the search index first harvests every transcript, so compaction summaries stay searchable', () => {
  const { home, run, push } = hydraId()
  const path = join(home, 's1.jsonl')
  writeFileSync(path, readFileSync(CLAUDE, 'utf8'))
  push({ key: 'claude:s1', card: { title: 'Invoices', agent: { provider: 'claude-code', sessionId: 's1', transcriptPath: path } } })
  assert.equal(noted().length, 0)
  assert.match(run({ args: ['oracle', 'zebrafish', '--kind', 'note'] }), /^ {2}- card: c1$/m)
  assert.equal(noted().length, 6)
  appendFileSync(path, `${JSON.stringify({ type: 'user', isCompactSummary: true, uuid: 'z2', message: { content: 'Quokka migration paused.' } })}\n`)
  assert.match(run({ args: ['oracle', 'rebuild'] }), /rebuilt:/)
  assert.equal(noted().length, 7)
  assert.match(run({ args: ['oracle', 'quokka', '--kind', 'note'] }), /^ {2}- card: c1$/m)
})

test("Codex's session index yields the session's latest thread name", () => {
  const index = [
    JSON.stringify({ id: 'x2', thread_name: 'Ledger drift', updated_at: '2026-10-12T10:00:00Z' }),
    'not json',
    JSON.stringify({ id: 'other', thread_name: 'Other work' }),
    JSON.stringify({ id: 'x2', thread_name: 'Ledger rounding fix', updated_at: '2026-10-12T11:00:00Z' }),
  ].join('\n')
  assert.deepEqual(codexThreadTitle({ index, sessionId: 'x2' }), [
    { kind: 'context', source: 'codex', text: 'Session title: Ledger rounding fix', ref: 'title:2026-10-12T11:00:00Z:Ledger rounding fix', at: '2026-10-12T11:00:00Z' },
  ])
  assert.deepEqual(codexThreadTitle({ index, sessionId: 'missing' }), [])
})

test("a hook-only card takes the harness's own session title over its first prompt", () => {
  const { home, run, push } = hydraId()

  const hookCard = ({ key, provider, transcriptPath }: {
    key: string
    provider: string
    transcriptPath: string
  }) => {
    const at = '2026-10-11T11:00:00.000Z'
    push({ key, card: { autoTitle: { from: 'prompt', text: 'fix the ledger please' }, agent: { provider, sessionId: key.split(':')[1], transcriptPath }, source: { adapter: 'hooks', objectId: key, observedAt: at } } })
  }

  hookCard({ key: 'claude:s1', provider: 'claude-code', transcriptPath: join(home, 's1.jsonl') })
  writeFileSync(join(home, 's1.jsonl'), `${JSON.stringify({ type: 'ai-title', aiTitle: 'Ledger rounding', sessionId: 's1' })}\n`)

  // Codex keeps thread names in session_index.jsonl in its home, beside sessions/.
  const codexHome = join(home, 'codex')
  const rollout = join(codexHome, 'sessions', '2026', '10', '12', 'rollout-x2.jsonl')
  mkdirSync(join(rollout, '..'), { recursive: true })
  copyFileSync(CODEX, rollout)
  writeFileSync(join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id: 'x2', thread_name: 'Ledger sync drift' })}\n`)
  hookCard({ key: 'codex:x2', provider: 'codex', transcriptPath: rollout })
  assert.match(run({ args: ['card', 'c2'] }), /^ {2}title: fix the ledger please$/m)

  run({ args: ['harvest'] })
  assert.match(run({ args: ['card', 'c1'] }), /^ {2}title: Ledger rounding$/m)
  assert.match(run({ args: ['card', 'c2'] }), /^ {2}title: Ledger sync drift$/m)
  assert.match(run({ args: ['harvest'] }), /none: nothing new/)
})

test('a session renamed back to an earlier title takes that title again', () => {
  const { home, run, push } = hydraId()
  const path = join(home, 's1.jsonl')
  writeFileSync(path, '')
  push({ key: 'claude:s1', card: { agent: { provider: 'claude-code', sessionId: 's1', transcriptPath: path } } })

  const codexHome = join(home, 'codex')
  const rollout = join(codexHome, 'sessions', '2026', '10', '12', 'rollout-x2.jsonl')
  mkdirSync(join(rollout, '..'), { recursive: true })
  writeFileSync(rollout, '')
  push({ key: 'codex:x2', card: { agent: { provider: 'codex', sessionId: 'x2', transcriptPath: rollout } } })
  const index = join(codexHome, 'session_index.jsonl')

  for (const [i, title] of ['Alpha', 'Beta', 'Alpha'].entries()) {
    appendFileSync(path, `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 's1' })}\n`)
    appendFileSync(index, `${JSON.stringify({ id: 'x2', thread_name: title, updated_at: `2026-10-12T1${i}:00:00Z` })}\n`)
    assert.match(run({ args: ['harvest'] }), /^ {2}notes: 2 new$/m)
    assert.match(run({ args: ['card', 'c1'] }), new RegExp(`^ {2}title: ${title}$`, 'm'))
    assert.match(run({ args: ['card', 'c2'] }), new RegExp(`^ {2}title: ${title}$`, 'm'))
  }

  appendFileSync(index, `${JSON.stringify({ id: 'x2', thread_name: 'Alpha', updated_at: '2026-10-12T13:00:00Z' })}\n`)
  appendFileSync(path, `${JSON.stringify({ type: 'custom-title', customTitle: 'Alpha', sessionId: 's1' })}\n`)
  assert.match(run({ args: ['harvest'] }), /none: nothing new/)
  writeFileSync(join(home, 'boards', 'default', 'harvest.json'), 'not json')
  assert.match(run({ args: ['harvest'] }), /none: nothing new/)
  assert.match(run({ args: ['card', 'c1'] }), /^ {2}title: Alpha$/m)
})
