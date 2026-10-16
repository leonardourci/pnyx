import { fixtureCli } from './cli-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import type { HydraEvent } from '../src/core/model.ts'
import { ftsQuery, search, updateIndex } from '../src/oracle/index.ts'
import { chunk, eventText, redact, transcriptMessages } from '../src/oracle/text.ts'

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
  const texts = records.flatMap(record => transcriptMessages({ record })).map(m => m.text)
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
  assert.deepEqual(records.flatMap(record => transcriptMessages({ record })), [
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
  } as HydraEvent
  assert.equal(eventText({ event: update }), 'b')
  const created = { ...update, data: { ...update.data, before: undefined } } as HydraEvent
  assert.equal(eventText({ event: created }), 'Same title\na\nb\nWhich region?')
  const link = { url: 'https://github.com/o/r/pull/7', kind: 'github_pr', number: 7, title: 'Fix it' } as const
  const linked = { ...base, type: 'card.linked', data: { url: link.url, before: null, after: link } } as HydraEvent
  assert.equal(eventText({ event: linked }), '#7 Fix it https://github.com/o/r/pull/7')
  const merged = { ...linked, data: { url: link.url, before: link, after: { ...link, state: 'merged' } } } as HydraEvent
  assert.equal(eventText({ event: merged }), '')
  const moved = { ...base, type: 'card.moved', reason: 'Keep in review', data: { before: null, after: 'review' } } as HydraEvent
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

const cards = ({ out }: { out: string }) => [...out.matchAll(/^ {2}- card: (\S+)$/gm)].map(m => m[1])

function hydraId() {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-oracle-'))
  const env = { ...process.env, PNYX_HOME: home }
  const run = fixtureCli({ home, execute: ({ args }) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) })
  const fails = ({ args, code }: { args: string[]; code: string }) =>
    assert.throws(() => run({ args: [...args] }), (error: { stdout: string }) => {
      assert.match(error.stdout, new RegExp(`^code: ${code}$`, 'm'))

      return true
    })

  const push = ({ key, card }: { key: string; card: object }) => {
    const file = join(home, `${key}.json`)
    writeFileSync(file, JSON.stringify(card))
    run({ args: ['push', '--key', key, '--file', file] })
  }

  const transcript = join(home, 'session.jsonl')
  copyFileSync(TRANSCRIPT, transcript)
  push({ key: 'claude:s1', card: { title: 'Orders migration', workspace: 'work', agent: { provider: 'claude', sessionId: 's1', transcriptPath: transcript } } })
  push({ key: 'claude:s2', card: { title: 'Checkout flake', workspace: 'home' } })
  run({ args: ['link', 'c2', '--url', 'https://github.com/o/r/pull/42', '--title', 'Fix checkout retry'] })
  run({ args: ['outcome', 'c2', 'done', '--note', 'rolled back release 4.2'] })

  return { home, run, fails, push, transcript }
}

test('search finds titles, links, notes and transcript text, ranked one per card', () => {
  const { run, home } = hydraId()
  assert.match(run({ args: ['oracle', 'status'] }), /^index: "none: not built yet"$/m)

  const reverted = run({ args: ['oracle', 'reverted'] })
  assert.match(reverted, /^mode: lexical$/m)
  assert.match(reverted, /^results\[1\]:\n {2}- card: c1\n {4}title: Orders migration\n {4}match: lexical\n {4}snippets\[\d\]\{kind,at,snippet\}:$/m)
  assert.match(reverted, /^ {6}transcript,"2026-10-11T09:00:00.000Z","Why did the deploy get \[reverted\]/m)
  assert.match(run({ args: ['oracle', '42'] }), /^ {6}event,.*#\[42\] Fix checkout retry/m)
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'rolled', 'back'] }) }), ['c2', 'c1'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'rolled', 'back', '--kind', 'event'] }) }), ['c2'])
  assert.match(run({ args: ['oracle', 'migration', '--workspace', 'home'] }), /^results: "none: no matches for \\"migration\\""$/m)
  assert.match(run({ args: ['oracle', 'redacted'] }), /token \[\[redacted\]\] to check/)

  for (const hidden of ['tooloutputword', 'secretthought', 'injectedreminder', 'sk-test1234567890abcdefXYZ', 'torntailword']) {
    assert.match(run({ args: ['oracle', hidden] }), /^results: "none: /m, hidden)
  }

  const backfill = run({ args: ['oracle', 'backfill', '--card', 'claude:s1', '--limit', '2'] })
  assert.deepEqual(cards({ out: backfill }), ['c1'])
  assert.match(backfill, /^ {4}snippets\[2\]/m)
  assert.match(backfill, /5 more matches; raise --limit/)

  // Every word must match on one card, not in one chunk: a title word and a note word.
  const mixed = run({ args: ['oracle', 'checkout', 'rolled'] })
  assert.deepEqual(cards({ out: mixed }), ['c2'])
  assert.match(mixed, /^ {6}event,.*"\[rolled\] back release 4\.2"$/m)
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'retry', 'release'] }) }), ['c2'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'orders', '--kind', 'transcript'] }) }), ['c1'])

  const status = run({ args: ['oracle', 'status'] })
  assert.match(status, /^index: current through seq 5$/m)
  assert.match(status, /^semantic: "off: run `pnyx-axi settings set oracle.semantic on` to turn it on"$/m)
  assert.match(status, /^ {2}tracked: 1$/m)
  assert.equal(statSync(join(home, 'hydras', 'default', 'search.db')).mode & 0o777, 0o600)
})

test("a Codex session's messages are searchable", () => {
  const { run, push, home } = hydraId()
  const codex = join(home, 'rollout.jsonl')
  copyFileSync(CODEX, codex)
  push({ key: 'codex:x1', card: { title: 'Invoice export', agent: { provider: 'codex', sessionId: 'x1', transcriptPath: codex } } })
  const invoice = run({ args: ['oracle', 'invoice', 'index'] })
  assert.deepEqual(cards({ out: invoice }), ['c5'])
  assert.match(invoice, /^ {6}transcript,"2026-10-12T10:00:07.000Z","The export query scans every \[invoice\] without an \[index\]\."$/m)

  for (const hidden of ['agentsmdword', 'developerword', 'envcontextword', 'codexthoughtword', 'codexcallword', 'codexoutputword', 'sessionmetaword']) {
    assert.match(run({ args: ['oracle', hidden] }), /^results: "none: /m, hidden)
  }
})

test('a renamed card or link is found by its new title', () => {
  const { run, push } = hydraId()
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'flake', 'rolled'] }) }), ['c2'])
  push({ key: 'claude:s2', card: { title: 'Checkout retries', workspace: 'home' } })
  run({ args: ['link', 'c2', '--url', 'https://github.com/o/r/pull/42', '--title', 'Harden payments'] })
  assert.match(run({ args: ['oracle', 'retries', 'rolled'] }), /^ {2}- card: c2\n {4}title: Checkout retries$/m)
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'payments', 'rolled'] }) }), ['c2'])
})

test('words from different entries of one card match the card, and --card matches one entry', () => {
  const { run, push, home } = hydraId()
  const session = join(home, 's2.jsonl')
  writeFileSync(session, `${JSON.stringify({ type: 'user', timestamp: '2026-10-12T08:00:00.000Z', message: { content: 'The checkout call hit a timeout' } })}\n`)
  push({ key: 'claude:s2', card: { title: 'Checkout flake', workspace: 'home', agent: { provider: 'claude', sessionId: 's2', transcriptPath: session } } })
  const spread = run({ args: ['oracle', 'rolled', 'timeout'] })
  assert.deepEqual(cards({ out: spread }), ['c2'])
  assert.match(spread, /^ {4}snippets\[2\]\{kind,at,snippet\}:$/m)
  assert.match(spread, /\[rolled\] back release/)
  assert.match(spread, /hit a \[timeout\]/)
  // With --card a title word matches only the entries that carry it, not every chunk of the card.
  const titled = run({ args: ['oracle', 'checkout', '--card', 'c2'] })
  assert.deepEqual(cards({ out: titled }), ['c2'])
  assert.match(titled, /^ {4}snippets\[3\]/m)
  assert.doesNotMatch(titled, /more matches/)
  assert.match(run({ args: ['oracle', 'rolled', 'timeout', '--card', 'c2'] }), /^results: "none: /m)
  assert.match(run({ args: ['oracle', 'checkout', '--card', 'c2', '--kind', 'transcript'] }), /^ {4}snippets\[1\]\{kind,at,snippet\}:\n {6}transcript,/m)
})

test('each search indexes what the log and transcripts gained', () => {
  const { run, push, transcript } = hydraId()
  run({ args: ['oracle', 'reverted'] })
  assert.match(run({ args: ['oracle', 'status'] }), /^index: current through seq 5$/m)
  push({ key: 'claude:s3', card: { title: 'Canary rollout' } })
  assert.match(run({ args: ['oracle', 'status'] }), /^index: "behind: through seq 5 of 6; the next search catches up"$/m)
  appendFileSync(transcript, `}}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Canary is green' }] } })}\n`)
  assert.equal(cards({ out: run({ args: ['oracle', 'canary'] }) }).length, 2)
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'torntailword'] }) }), ['c1'])
  assert.match(run({ args: ['oracle', 'canary', '--card', 'c1'] }), /^ {6}transcript,unknown,"\[Canary\] is green"$/m)
})

test('a replaced or shortened transcript is read again from the start', () => {
  const { run, transcript, home } = hydraId()
  assert.match(run({ args: ['oracle', 'reverted'] }), /^results\[1\]/m)
  const replacement = join(home, 'new.jsonl')
  writeFileSync(replacement, `${JSON.stringify({ type: 'user', message: { content: 'compacted summary of the outage' } })}\n`)
  renameSync(replacement, transcript)
  assert.match(run({ args: ['oracle', 'reverted'] }), /^results: "none: /m)
  assert.match(run({ args: ['oracle', 'outage'] }), /^results\[1\]/m)
  writeFileSync(transcript, '')
  assert.match(run({ args: ['oracle', 'outage'] }), /^results: "none: /m)
})

test('rebuild recreates the index from the sources', () => {
  const { run, home } = hydraId()
  run({ args: ['oracle', 'reverted'] })
  const db = join(home, 'hydras', 'default', 'search.db')
  writeFileSync(db, 'not a database')
  assert.match(run({ args: ['oracle', 'status'] }), /^index: "stale: /m)
  assert.match(run({ args: ['oracle', 'reverted'] }), /^results\[1\]/m)
  assert.match(run({ args: ['oracle', 'rebuild'] }), /^ {2}docs: 15$/m)
  assert.match(run({ args: ['oracle', 'reverted'] }), /^results\[1\]/m)
})

test('search refuses bad input with structured errors', () => {
  const { fails } = hydraId()
  fails({ args: ['oracle'], code: 'VALIDATION_ERROR' })
  fails({ args: ['oracle', '-', '--kind', 'event'], code: 'VALIDATION_ERROR' })
  fails({ args: ['oracle', 'x', '--kind', 'title'], code: 'VALIDATION_ERROR' })
  fails({ args: ['oracle', 'x', '--limit', '0'], code: 'VALIDATION_ERROR' })
  fails({ args: ['oracle', 'x', '--card', 'nope'], code: 'NOT_FOUND' })
})

test('words match by stem, ignoring case and accents', () => {
  const { run, push } = hydraId()
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'deploying', 'migrations'] }) }), ['c1'])
  push({ key: 'claude:s3', card: { title: 'Migração do banco' } })
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'migracao'] }) }), ['c6'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'MIGRAÇÃO'] }) }), ['c6'])
})

test('a word matches its synonyms', () => {
  const { run, push } = hydraId()
  push({ key: 'claude:s3', card: { title: 'Review the PR before lunch' } })
  push({ key: 'claude:s4', card: { title: 'Issue triage' } })
  // deploy, release and ship are one group: the transcript's deploy and the note's release.
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'ship'] }) }).sort(), ['c1', 'c2'])
  assert.match(run({ args: ['oracle', 'rollback', '--card', 'c1'] }), /get \[reverted\] after/)
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'pull', 'request', 'lunch'] }) }), ['c5'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'ticket'] }) }), ['c6'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'PR?'] }) }), ['c5'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', '(pull', 'request),', 'lunch'] }) }), ['c5'])
  assert.match(run({ args: ['oracle', 'status'] }), /^synonyms: "v1, 4 groups"$/m)
})

test('when nothing matches, typos and partial words match the nearest indexed words', () => {
  const { run } = hydraId()
  const typo = run({ args: ['oracle', 'chekout'] })
  assert.match(typo, /^mode: fuzzy$/m)
  assert.match(typo, /^results\[1\]:\n {2}- card: c2\n {4}title: Checkout flake\n {4}match: fuzzy$/m)
  assert.match(typo, /\[checkout\] retry/)
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'checko'] }) }).sort(), ['c1', 'c2'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'ckout'] }) }), ['c2'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'chekout', 'migratoin'] }) }), [])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'chekout', 'relese'] }) }), ['c2'])
  assert.match(run({ args: ['oracle', 'checkout'] }), /^mode: lexical$/m)
  assert.match(run({ args: ['oracle', 'zzqqxx'] }), /^results: "none: /m)
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'chekout?'] }) }), ['c2'])
})

test('a word ending in * matches the indexed words starting with it', () => {
  const { run, push } = hydraId()
  push({ key: 'claude:s3', card: { title: 'Retryable error' } })
  push({ key: 'claude:s4', card: { title: 'Deployment ready' } })
  // FTS5 stems "retry"* to retri*, which misses retryable; the indexed words fill the gap.
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'retry*'] }) }).sort(), ['c2', 'c5'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'deploy*'] }) }).sort(), ['c1', 'c6'])
  assert.deepEqual(cards({ out: run({ args: ['oracle', 'deplo*'] }) }).sort(), ['c1', 'c6'])
})

test('Hydra messages are searchable without a task, including after rebuild', () => {
  const { run, home } = hydraId()
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = home

  try {
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'hydra-lunch',
            at: '2026-10-15T10:00:00Z',
            actor: 'user',
            cardId: '$board',
            type: 'hydra.message',
            data: { action: 'send', text: 'I will review the layout after lunch.', hydra: 'hydra' },
          },
        })
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'hydra-reply',
            at: '2026-10-15T10:01:00Z',
            actor: 'hooks',
            cardId: '$hydra',
            type: 'chat.message',
            data: { session: 'hydra', nativeId: '0', role: 'assistant', text: 'The lunchtime review is ready.' },
          },
        })
      },
    })
    const lunch = run({ args: ['oracle', 'lunch'] })
    assert.match(lunch, /card: \$board\n {4}title: Hydra\n {4}kind: hydra/)
    assert.match(lunch, /after \[lunch\]/)
    assert.doesNotMatch(lunch, /pnyx-axi card \$board/)
    assert.match(run({ args: ['oracle', 'lunchtime', '--kind', 'transcript'] }), /kind: hydra/)
    assert.match(run({ args: ['oracle', 'lunch', '--workspace', 'work'] }), /^results: "none: /m)
    run({ args: ['oracle', 'rebuild'] })
    assert.match(run({ args: ['oracle', 'lunch'] }), /kind: hydra/)
  } finally {
    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }
  }
})

test('live Hydra searches exclude hidden sessions before applying the result limit', () => {
  const { run, home, push } = hydraId()
  run({ args: ['hydra', 'create', 'default'] })
  push({ key: 'claude:hidden', card: { title: 'Hidden flamingo session', agent: { provider: 'claude-code', sessionId: 'hidden' }, source: { adapter: 'hooks', objectId: 'hidden' } } })
  run({ args: ['task', 'create', '--title', 'Visible flamingo task'] })
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = home

  try {
    assert.ok(Object.values(loadHydra({ hydraId: 'default' }).state.cards).some(card => card.hidden && card.title === 'Hidden flamingo session'))
    updateIndex({ hydraId: 'default' })
    const hits = search({ hydraId: 'default', query: { text: 'flamingo', live: true, limit: 1 } }).hits
    assert.deepEqual(hits.map(hit => hit.title), ['Visible flamingo task'])
    assert.match(run({ args: ['oracle', 'flamingo'] }), /Hidden flamingo session/)
  } finally {
    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }
  }
})

test('a live Hydra transcript joins its Hydra conversation before a turn-end hook', () => {
  const { run, home, push } = hydraId()
  run({ args: ['hydra', 'create', 'default'] })
  const transcript = join(home, 'hydra.jsonl')
  writeFileSync(transcript, '')
  push({ key: 'claude:hydra-live', card: { agent: { provider: 'claude-code', sessionId: 'hydra-live', transcriptPath: transcript }, source: { adapter: 'hooks', objectId: 'hydra-live' } } })
  run({ args: ['oracle', 'rebuild'] })
  run({ args: ['hydra', 'set', '--session', 'claude-code:hydra-live'] })
  appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: 'The flamingo investigation is ready.' } })}\n`)
  const found = run({ args: ['oracle', 'flamingo'] })
  assert.match(found, /card: \$board\n {4}title: Hydra\n {4}kind: hydra/)
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: 'The canary review is ready.' } })}\n`)
  assert.match(run({ args: ['oracle', 'flamingo'] }), /^results: "none: /m)
  assert.match(run({ args: ['oracle', 'canary'] }), /kind: hydra/)
})

test('unhighlighted snippets preserve Markdown URLs, brackets and line breaks', () => {
  const home = mkdtempSync(join(tmpdir(), 'pnyx-oracle-markdown-'))
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = home
  const text = '[PR](https://github.com/example/project/pull/42)\n\n- **Ready** [literal].'

  try {
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: 1,
          id: 'markdown',
          at: '2026-10-15T10:00:00Z',
          actor: 'fixture',
          cardId: '$board',
          type: 'hydra.message',
          data: { action: 'send', text, hydra: 'hydra' },
        },
      }),
    })
    updateIndex({ hydraId: 'default' })

    for (const query of ['project', 'github']) {
      const result = search({ hydraId: 'default', query: { text: query, limit: 1, highlight: false } })
      assert.equal(result.hits[0]?.snippets[0]?.snippet, text)
    }

    const highlighted = search({ hydraId: 'default', query: { text: 'project', limit: 1 } })
    assert.match(highlighted.hits[0]!.snippets[0]!.snippet, /example\/\[project\]\/pull/)
  } finally {
    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }

    rmSync(home, { recursive: true, force: true })
  }
})
