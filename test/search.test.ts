import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BoardEvent } from '../src/core/model.ts'
import { ftsQuery } from '../src/search/index.ts'
import { chunk, eventText, redact, transcriptMessages } from '../src/search/text.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')
const TRANSCRIPT = join(import.meta.dirname, 'fixtures', 'transcripts', 'claude-session.jsonl')
const CODEX = join(import.meta.dirname, 'fixtures', 'transcripts', 'codex-session.jsonl')

test('a short message is one chunk; a long one splits on paragraphs, deterministically', () => {
  assert.deepEqual(chunk({ text: '  one line  ' }), ['one line'])
  assert.deepEqual(chunk({ text: ' \n ' }), [])
  const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'word '.repeat(50).trim()}`)
  const chunks = chunk({ text: paragraphs.join('\n\n') })
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(c => c.length <= 768))
  assert.deepEqual(chunk({ text: paragraphs.join('\n\n') }), chunks)
  // Each chunk after the first starts with the previous chunk's last paragraph.
  assert.equal(chunks[1]!.split('\n\n')[0], chunks[0]!.split('\n\n').at(-1))

  for (const p of paragraphs) {
    assert.ok(chunks.some(c => c.includes(p)))
  }
})

test('a code fence stays whole and an overlong line is cut', () => {
  const fence = ['```', 'a', '', 'b', '```'].join('\n')
  const chunks = chunk({ text: `${'intro '.repeat(120)}\n\n${fence}` })
  assert.ok(chunks.some(c => c.includes(fence)))
  const long = chunk({ text: 'x'.repeat(2000) })
  assert.deepEqual(long.map(c => c.length), [768, 768, 464])
})

test('secret-shaped strings are redacted', () => {
  const text = [
    'sk-abcdefghijklmnop1234',
    'ghp_abcdefghijklmnopqrstuvwxyz',
    'github_pat_abcdefghijklmnopqrstuvwxyz',
    'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop',
    '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
  ].join(' ')
  assert.equal(redact({ text }), Array(6).fill('[redacted]')
    .join(' '))
  assert.equal(redact({ text: 'skip the sk- prefix' }), 'skip the sk- prefix')
})

test('only typed messages and assistant text are read from a transcript', () => {
  const records = readFileSync(TRANSCRIPT, 'utf8').split('\n')
    .slice(0, -1)
    .map(l => JSON.parse(l) as unknown)
  const texts = records.flatMap(arg0 => transcriptMessages({ record: arg0 })).map(m => m.text)
  assert.equal(texts[0], 'Why did the deploy get reverted after the migration?')
  assert.equal(texts[1], 'The migration locked the orders table, so the deploy was rolled back.')
  const all = texts.join('\n')

  for (const hidden of ['toolinputword', 'tooloutputword', 'secretthought', 'metaskillbody', 'injectedreminder', 'summaryrecordword']) {
    assert.ok(!all.includes(hidden), hidden)
  }

  assert.match(all, /Use the token sk-/)
})

test('only typed messages and assistant text are read from a Codex transcript', () => {
  const records = readFileSync(CODEX, 'utf8').split('\n')
    .slice(0, -1)
    .map(l => JSON.parse(l) as unknown)
  assert.deepEqual(records.flatMap(arg0 => transcriptMessages({ record: arg0 })), [
    { at: '2026-10-12T10:00:03.000Z', text: 'Why is the invoice export timing out?' },
    { at: '2026-10-12T10:00:07.000Z', text: 'The export query scans every invoice without an index.' },
  ])
})

test("an event's text is what it changed", () => {
  const base = { v: 1, seq: 2, id: 'e2', at: '2026-10-13T00:00:00Z', actor: 'cli', cardId: 'c1' } as const
  const update = {
    ...base,
    type: 'card.pushed',
    data: { key: 'k', title: 'Same title', tags: ['a', 'b'], attention: [{ kind: 'question', key: 'q1', blocking: true, text: 'Which region?' }], before: { tags: ['a'] } },
  } as BoardEvent
  assert.equal(eventText({ event: update }), 'b')
  const created = { ...update, data: { ...update.data, before: undefined } } as BoardEvent
  assert.equal(eventText({ event: created }), 'Same title\na\nb\nWhich region?')
  const link = { url: 'https://github.com/o/r/pull/7', kind: 'github_pr', number: 7, title: 'Fix it' } as const
  const linked = { ...base, type: 'card.linked', data: { url: link.url, before: null, after: link } } as BoardEvent
  assert.equal(eventText({ event: linked }), '#7 Fix it https://github.com/o/r/pull/7')
  const merged = { ...linked, data: { url: link.url, before: link, after: { ...link, state: 'merged' } } } as BoardEvent
  assert.equal(eventText({ event: merged }), '')
  const moved = { ...base, type: 'card.moved', reason: 'Keep in review', data: { before: null, after: 'review' } } as BoardEvent
  assert.equal(eventText({ event: moved }), 'Keep in review')
})

test('query words and phrases in a synonym group match the whole group', () => {
  assert.equal(ftsQuery({ text: 'Rollback the pull request' }), '("rollback" OR "revert") AND "the" AND ("pr" OR "pull request")')
  assert.equal(ftsQuery({ text: 'ship*' }), '"ship"*')
})

test('query words are quoted so punctuation is never FTS5 syntax', () => {
  assert.equal(ftsQuery({ text: 'fix "AND" -x pull/7 deplo* :' }), '"fix" AND """AND""" AND "-x" AND "pull/7" AND "deplo"*')
  assert.equal(ftsQuery({ text: ' - : ' }), '')
})

// The card ids of a search's results, best first.
const cards = (out: string) => [...out.matchAll(/^ {2}- card: (\S+)$/gm)].map(m => m[1])

function board() {
  // Tests never touch the real ~/.pnyx.
  const home = mkdtempSync(join(tmpdir(), 'pnyx-search-'))
  const env = { ...process.env, PNYX_HOME: home }
  const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const fails = (args: string[], code: string) =>
    assert.throws(() => run(...args), (error: { stdout: string }) => {
      assert.match(error.stdout, new RegExp(`^code: ${code}$`, 'm'))

      return true
    })

  const push = (key: string, card: object) => {
    const file = join(home, `${key}.json`)
    writeFileSync(file, JSON.stringify(card))
    run('push', '--key', key, '--file', file)
  }

  const transcript = join(home, 'session.jsonl')
  copyFileSync(TRANSCRIPT, transcript)
  push('claude:s1', { title: 'Orders migration', workspace: 'work', agent: { provider: 'claude', sessionId: 's1', transcriptPath: transcript } })
  push('claude:s2', { title: 'Checkout flake', workspace: 'home' })
  run('link', 'c2', '--url', 'https://github.com/o/r/pull/42', '--title', 'Fix checkout retry')
  run('outcome', 'c2', 'done', '--note', 'rolled back release 4.2')

  return { home, run, fails, push, transcript }
}

test('search finds titles, links, notes and transcript text, ranked one per card', () => {
  const { run, home } = board()
  assert.match(run('search', 'status'), /^index: "none: not built yet"$/m)

  const reverted = run('search', 'reverted')
  assert.match(reverted, /^mode: lexical$/m)
  assert.match(reverted, /^results\[1\]:\n {2}- card: c1\n {4}title: Orders migration\n {4}match: lexical\n {4}snippets\[\d\]\{kind,at,snippet\}:$/m)
  assert.match(reverted, /^ {6}transcript,"2026-10-11T09:00:00.000Z","Why did the deploy get \[reverted\]/m)
  assert.match(run('search', '42'), /^ {6}event,.*#\[42\] Fix checkout retry/m)
  assert.deepEqual(cards(run('search', 'rolled', 'back')), ['c2', 'c1'])
  assert.deepEqual(cards(run('search', 'rolled', 'back', '--kind', 'event')), ['c2'])
  assert.match(run('search', 'migration', '--workspace', 'home'), /^results: "none: no matches for \\"migration\\""$/m)
  assert.match(run('search', 'redacted'), /token \[\[redacted\]\] to check/)

  for (const hidden of ['tooloutputword', 'secretthought', 'injectedreminder', 'sk-test1234567890abcdefXYZ', 'torntailword']) {
    assert.match(run('search', hidden), /^results: "none: /m, hidden)
  }

  const backfill = run('search', 'backfill', '--card', 'claude:s1', '--limit', '2')
  assert.deepEqual(cards(backfill), ['c1'])
  assert.match(backfill, /^ {4}snippets\[2\]/m)
  assert.match(backfill, /5 more matches; raise --limit/)

  // Every word must match on one card, not in one chunk: a title word and a note word.
  const mixed = run('search', 'checkout', 'rolled')
  assert.deepEqual(cards(mixed), ['c2'])
  assert.match(mixed, /^ {6}event,.*"\[rolled\] back release 4\.2"$/m)
  assert.deepEqual(cards(run('search', 'retry', 'release')), ['c2'])
  assert.deepEqual(cards(run('search', 'orders', '--kind', 'transcript')), ['c1'])

  const status = run('search', 'status')
  assert.match(status, /^index: current through seq 5$/m)
  assert.match(status, /^semantic: "off: run `pnyx-axi settings set search.semantic on` to turn it on"$/m)
  assert.match(status, /^ {2}tracked: 1$/m)
  assert.equal(statSync(join(home, 'boards', 'default', 'search.db')).mode & 0o777, 0o600)
})

test("a Codex session's messages are searchable", () => {
  const { run, push, home } = board()
  const codex = join(home, 'rollout.jsonl')
  copyFileSync(CODEX, codex)
  push('codex:x1', { title: 'Invoice export', agent: { provider: 'codex', sessionId: 'x1', transcriptPath: codex } })
  const invoice = run('search', 'invoice', 'index')
  assert.deepEqual(cards(invoice), ['c5'])
  assert.match(invoice, /^ {6}transcript,"2026-10-12T10:00:07.000Z","The export query scans every \[invoice\] without an \[index\]\."$/m)

  for (const hidden of ['agentsmdword', 'developerword', 'envcontextword', 'codexthoughtword', 'codexcallword', 'codexoutputword', 'sessionmetaword']) {
    assert.match(run('search', hidden), /^results: "none: /m, hidden)
  }
})

test('a renamed card or link is found by its new title', () => {
  const { run, push } = board()
  assert.deepEqual(cards(run('search', 'flake', 'rolled')), ['c2'])
  push('claude:s2', { title: 'Checkout retries', workspace: 'home' })
  run('link', 'c2', '--url', 'https://github.com/o/r/pull/42', '--title', 'Harden payments')
  assert.match(run('search', 'retries', 'rolled'), /^ {2}- card: c2\n {4}title: Checkout retries$/m)
  assert.deepEqual(cards(run('search', 'payments', 'rolled')), ['c2'])
})

test('words from different entries of one card match the card, and --card matches one entry', () => {
  const { run, push, home } = board()
  const session = join(home, 's2.jsonl')
  writeFileSync(session, `${JSON.stringify({ type: 'user', timestamp: '2026-10-12T08:00:00.000Z', message: { content: 'The checkout call hit a timeout' } })}\n`)
  push('claude:s2', { title: 'Checkout flake', workspace: 'home', agent: { provider: 'claude', sessionId: 's2', transcriptPath: session } })
  const spread = run('search', 'rolled', 'timeout')
  assert.deepEqual(cards(spread), ['c2'])
  assert.match(spread, /^ {4}snippets\[2\]\{kind,at,snippet\}:$/m)
  assert.match(spread, /\[rolled\] back release/)
  assert.match(spread, /hit a \[timeout\]/)
  // With --card a title word matches only the entries that carry it, not every chunk of the card.
  const titled = run('search', 'checkout', '--card', 'c2')
  assert.deepEqual(cards(titled), ['c2'])
  assert.match(titled, /^ {4}snippets\[3\]/m)
  assert.doesNotMatch(titled, /more matches/)
  assert.match(run('search', 'rolled', 'timeout', '--card', 'c2'), /^results: "none: /m)
  assert.match(run('search', 'checkout', '--card', 'c2', '--kind', 'transcript'), /^ {4}snippets\[1\]\{kind,at,snippet\}:\n {6}transcript,/m)
})

test('each search indexes what the log and transcripts gained', () => {
  const { run, push, transcript } = board()
  run('search', 'reverted')
  assert.match(run('search', 'status'), /^index: current through seq 5$/m)
  push('claude:s3', { title: 'Canary rollout' })
  assert.match(run('search', 'status'), /^index: "behind: through seq 5 of 6; the next search catches up"$/m)
  // The torn last line completes, and a new message lands.
  appendFileSync(transcript, `}}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Canary is green' }] } })}\n`)
  assert.equal(cards(run('search', 'canary')).length, 2)
  assert.deepEqual(cards(run('search', 'torntailword')), ['c1'])
  assert.match(run('search', 'canary', '--card', 'c1'), /^ {6}transcript,unknown,"\[Canary\] is green"$/m)
})

test('a replaced or shortened transcript is read again from the start', () => {
  const { run, transcript, home } = board()
  assert.match(run('search', 'reverted'), /^results\[1\]/m)
  const replacement = join(home, 'new.jsonl')
  writeFileSync(replacement, `${JSON.stringify({ type: 'user', message: { content: 'compacted summary of the outage' } })}\n`)
  renameSync(replacement, transcript)
  assert.match(run('search', 'reverted'), /^results: "none: /m)
  assert.match(run('search', 'outage'), /^results\[1\]/m)
  writeFileSync(transcript, '')
  assert.match(run('search', 'outage'), /^results: "none: /m)
})

test('rebuild recreates the index from the sources', () => {
  const { run, home } = board()
  run('search', 'reverted')
  const db = join(home, 'boards', 'default', 'search.db')
  writeFileSync(db, 'not a database')
  assert.match(run('search', 'status'), /^index: "stale: /m)
  assert.match(run('search', 'reverted'), /^results\[1\]/m)
  assert.match(run('search', 'rebuild'), /^ {2}docs: 15$/m)
  assert.match(run('search', 'reverted'), /^results\[1\]/m)
})

test('search refuses bad input with structured errors', () => {
  const { fails } = board()
  fails(['search'], 'VALIDATION_ERROR')
  fails(['search', '-', '--kind', 'event'], 'VALIDATION_ERROR')
  fails(['search', 'x', '--kind', 'title'], 'VALIDATION_ERROR')
  fails(['search', 'x', '--limit', '0'], 'VALIDATION_ERROR')
  fails(['search', 'x', '--card', 'nope'], 'NOT_FOUND')
})

test('words match by stem, ignoring case and accents', () => {
  const { run, push } = board()
  assert.deepEqual(cards(run('search', 'deploying', 'migrations')), ['c1'])
  push('claude:s3', { title: 'Migração do banco' })
  assert.deepEqual(cards(run('search', 'migracao')), ['c6'])
  assert.deepEqual(cards(run('search', 'MIGRAÇÃO')), ['c6'])
})

test('a word matches its synonyms', () => {
  const { run, push } = board()
  push('claude:s3', { title: 'Review the PR before lunch' })
  push('claude:s4', { title: 'Issue triage' })
  // deploy, release and ship are one group: the transcript's deploy and the note's release.
  assert.deepEqual(cards(run('search', 'ship')).sort(), ['c1', 'c2'])
  assert.match(run('search', 'rollback', '--card', 'c1'), /get \[reverted\] after/)
  assert.deepEqual(cards(run('search', 'pull', 'request', 'lunch')), ['c5'])
  assert.deepEqual(cards(run('search', 'ticket')), ['c6'])
  // Punctuation around a word does not hide its synonyms.
  assert.deepEqual(cards(run('search', 'PR?')), ['c5'])
  assert.deepEqual(cards(run('search', '(pull', 'request),', 'lunch')), ['c5'])
  assert.match(run('search', 'status'), /^synonyms: "v1, 4 groups"$/m)
})

test('when nothing matches, typos and partial words match the nearest indexed words', () => {
  const { run } = board()
  const typo = run('search', 'chekout')
  assert.match(typo, /^mode: fuzzy$/m)
  assert.match(typo, /^results\[1\]:\n {2}- card: c2\n {4}title: Checkout flake\n {4}match: fuzzy$/m)
  assert.match(typo, /\[checkout\] retry/)
  // A partial word matches the words containing it and the words near it: checkout, and check in c1's transcript.
  assert.deepEqual(cards(run('search', 'checko')).sort(), ['c1', 'c2'])
  assert.deepEqual(cards(run('search', 'ckout')), ['c2'])
  // Every word must still match: a typo next to a word on another card finds nothing.
  assert.deepEqual(cards(run('search', 'chekout', 'migratoin')), [])
  assert.deepEqual(cards(run('search', 'chekout', 'relese')), ['c2'])
  // An exact match wins: no fuzzy expansion when the words match as typed.
  assert.match(run('search', 'checkout'), /^mode: lexical$/m)
  assert.match(run('search', 'zzqqxx'), /^results: "none: /m)
  // Punctuation around a typo does not stop it matching the nearest words.
  assert.deepEqual(cards(run('search', 'chekout?')), ['c2'])
})

test('a word ending in * matches the indexed words starting with it', () => {
  const { run, push } = board()
  push('claude:s3', { title: 'Retryable error' })
  push('claude:s4', { title: 'Deployment ready' })
  // FTS5 stems "retry"* to retri*, which misses retryable; the indexed words fill the gap.
  assert.deepEqual(cards(run('search', 'retry*')).sort(), ['c2', 'c5'])
  assert.deepEqual(cards(run('search', 'deploy*')).sort(), ['c1', 'c6'])
  assert.deepEqual(cards(run('search', 'deplo*')).sort(), ['c1', 'c6'])
})
