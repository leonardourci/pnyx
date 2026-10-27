// Harvested notes: the titles, summaries and answered questions transcripts already hold.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { codexThreadTitle, transcriptNotes } from '../src/integrations/hooks/notes.ts'
import { transcriptMessages } from '../src/oracle/text.ts'

const FIXTURES = join(
  import.meta.dirname,
  'fixtures',
)
const CLAUDE = join(
  FIXTURES,
  'transcripts',
  'claude-notes.jsonl',
)
const CODEX = join(
  FIXTURES,
  'transcripts',
  'codex-notes.jsonl',
)

const records = ({ path }: { path: string }) => readFileSync(
  path,
  'utf8',
).split('\n')
  .slice(
    0,
    -1,
  )
  .map(l => JSON.parse(l) as unknown)

test(
  'a Claude Code transcript yields its titles, compaction summaries and answered questions; a Codex one its readable summaries',
  () => {
    const notes = records({ path: CLAUDE }).flatMap(record => transcriptNotes({ record }))
    assert.deepEqual(
      notes.map(({
        kind,
        source,
        text,
        at,
      }) => ({
        kind,
        source,
        text,
        ...(at ? { at } : {}),
      })),
      [
        {
          kind: 'context',
          source: 'claude-code',
          text: 'Session title: Nightly invoice export',
        },
        {
          kind: 'context',
          source: 'claude-code',
          text: 'Session title: Nightly invoice export',
        },
        {
          kind: 'decision',
          source: 'claude-code',
          text: 'Which time window should the batch use?\nAnswer: 2am UTC',
          at: '2026-10-11T09:02:00.000Z',
        },
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
        {
          kind: 'context',
          source: 'claude-code',
          text: 'Session title: Invoice batch rollout',
        },
        {
          kind: 'summary',
          source: 'claude-code',
          text: 'Invoice export moved to a nightly batch',
        },
      ],
    )
    assert.equal(
      notes[0]!.ref,
      notes[1]!.ref,
    )
    assert.equal(
      new Set(notes.map(n => n.ref)).size,
      notes.length - 1,
    )
    assert.ok(!records({ path: CLAUDE }).flatMap(record => transcriptMessages({ record }))
      .some(m => m.text.includes('zebrafish')))
    assert.deepEqual(
      records({ path: CODEX }).flatMap(record => transcriptNotes({ record }))
        .map(({
          kind,
          source,
          text,
          at,
        }) => ({
          kind,
          source,
          text,
          at,
        })),
      [
        {
          kind: 'summary',
          source: 'codex',
          text: 'The ledger sync drifts because rounding happens before currency conversion.',
          at: '2026-10-12T11:00:00.000Z',
        },
      ],
    )
  },
)

test(
  "Codex's session index yields the session's latest thread name",
  () => {
    const index = [
      JSON.stringify({
        id: 'x2',
        thread_name: 'Ledger drift',
        updated_at: '2026-10-12T10:00:00Z',
      }),
      'not json',
      JSON.stringify({
        id: 'other',
        thread_name: 'Other work',
      }),
      JSON.stringify({
        id: 'x2',
        thread_name: 'Ledger rounding fix',
        updated_at: '2026-10-12T11:00:00Z',
      }),
    ].join('\n')
    assert.deepEqual(
      codexThreadTitle({
        index,
        sessionId: 'x2',
      }),
      [
        {
          kind: 'context',
          source: 'codex',
          text: 'Session title: Ledger rounding fix',
          ref: 'title:2026-10-12T11:00:00Z:Ledger rounding fix',
          at: '2026-10-12T11:00:00Z',
        },
      ],
    )
    assert.deepEqual(
      codexThreadTitle({
        index,
        sessionId: 'missing',
      }),
      [],
    )
  },
)
