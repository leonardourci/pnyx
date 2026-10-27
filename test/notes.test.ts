import { fixtureCli } from './cli-fixture.ts'
// Harvested notes: summaries, decisions and context that transcripts and linked
// pull requests already hold, folded into cards and search. Fixtures and a temp
// PNYX_HOME only; gh-axi is a fake.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codexThreadTitle, transcriptNotes } from '../src/integrations/hooks/notes.ts'
import { transcriptMessages } from '../src/oracle/text.ts'
import { loadHydra, readEvents, spoolWrite } from '../src/store/hydra-store.ts'

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
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
const GH_AXI = join(
  FIXTURES,
  'github',
  'gh-axi.sh',
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

function hydraId() {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-notes-',
  ))
  process.env.PNYX_HOME = home
  const env = {
    ...process.env,
    PNYX_HOME: home,
    PNYX_GH_AXI: GH_AXI,
  }
  const run = fixtureCli({
    home,
    execute: ({ args }) => execFileSync(
      process.execPath,
      [
        BIN,
        ...args,
      ],
      {
        env,
        encoding: 'utf8',
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    ),
  })
  const fails = ({
    args,
    code,
  }: {
    args: string[]
    code: string
  }) =>
    assert.throws(
      () => run({ args: [...args] }),
      (error: { stdout: string }) => {
        assert.match(
          error.stdout,
          new RegExp(
            `^code: ${code}$`,
            'm',
          ),
        )

        return true
      },
    )

  const push = ({
    key,
    card,
  }: {
    key: string
    card: object
  }) => {
    const file = join(
      home,
      'card.json',
    )
    writeFileSync(
      file,
      JSON.stringify(card),
    )
    run({
      args: [
        'push',
        '--key',
        key,
        '--file',
        file,
      ],
    })
  }

  const transcript = ({
    name,
    from,
  }: {
    name: string
    from: string
  }) => {
    const path = join(
      home,
      name,
    )
    copyFileSync(
      from,
      path,
    )

    return path
  }

  return {
    home,
    run,
    fails,
    push,
    transcript,
  }
}

const noted = () => readEvents({ hydraId: 'default' }).filter(e => e.type === 'card.noted')

const card = ({ key }: { key: string }) => {
  const { state } = loadHydra({ hydraId: 'default' })

  return state.cards[state.keys[key]!]!
}

test(
  'harvest folds transcript notes and pull requests into cards once, without moving or updating them',
  () => {
    const {
      run,
      fails,
      push,
      transcript,
    } = hydraId()
    push({
      key: 'claude:s1',
      card: {
        title: 'Invoices',
        agent: {
          provider: 'claude-code',
          sessionId: 's1',
          transcriptPath: transcript({
            name: 's1.jsonl',
            from: CLAUDE,
          }),
        },
      },
    })
    push({
      key: 'codex:x2',
      card: {
        title: 'Ledger',
        agent: {
          provider: 'codex',
          sessionId: 'x2',
          transcriptPath: transcript({
            name: 'x2.jsonl',
            from: CODEX,
          }),
        },
      },
    })
    run({
      args: [
        'link',
        'c1',
        '--url',
        'https://github.com/o/r/pull/42',
      ],
    })
    run({
      args: [
        'link',
        'c1',
        '--url',
        'https://github.com/o/r/pull/7',
      ],
    })
    const before = card({ key: 'claude:s1' })
    const out = run({ args: ['harvest'] })
    assert.match(
      out,
      /^ {2}notes: 8 new$/m,
    )
    assert.match(
      out,
      /^ {2}pullRequests: 1$/m,
    )
    assert.match(
      out,
      /^unread\[1\]: "https:\/\/github.com\/o\/r\/pull\/7"$/m,
    )
    assert.match(
      run({ args: ['harvest'] }),
      /^ {2}notes: "none: nothing new"$/m,
    )
    assert.equal(
      noted().length,
      8,
    )
    assert.ok(noted().every(e => e.actor === 'harvest'))
    // A note is no update: the card keeps its place and its updated time.
    const after = card({ key: 'claude:s1' })
    assert.equal(
      after.revision,
      before.revision + after.notes!.length,
    )
    assert.equal(
      after.updatedSeq,
      before.updatedSeq,
    )
    assert.equal(
      after.updatedAt,
      before.updatedAt,
    )

    const shown = run({
      args: [
        'card',
        'c1',
      ],
    })
    assert.match(
      shown,
      /^notes:\n {2}summary\[2\]\{at,source,text\}:$/m,
    )
    assert.match(
      shown,
      /^ {2}decisions\[2\]\{at,source,text\}:\n {4}"2026-10-11T09:02:00.000Z",claude-code,"Which time window/m,
    )
    assert.match(
      shown,
      /^ {2}context\[3\]\{at,source,text\}:$/m,
    )
    assert.match(
      shown,
      /github,"Pull request #42: Nightly invoice export\\n\\nMoves the invoice export to a 2am UTC batch\."$/m,
    )
    assert.doesNotMatch(
      shown,
      /pipelineevidenceword|templatemarkerword/,
    )
    assert.match(
      shown,
      /pnyx-axi card c1 --full/,
    )
    assert.match(
      run({
        args: [
          'card',
          'c1',
          '--full',
        ],
      }),
      /Pending: drop the on-demand export/,
    )
    assert.match(
      run({
        args: [
          'card',
          'c2',
        ],
      }),
      /^ {2}summary\[1\]\{at,source,text\}:\n {4}"2026-10-12T11:00:00.000Z",codex,The ledger sync drifts/m,
    )

    fails({
      args: [
        'undo',
        noted()[0]!.id,
      ],
      code: 'NOT_UNDOABLE',
    })
    fails({
      args: [
        'harvest',
        '--card',
        'nope',
      ],
      code: 'NOT_FOUND',
    })
  },
)

for (const event of [
  'Stop',
  'PostCompact',
]) {
  test(
    `a session is harvested when its ${event} hook event is ingested`,
    () => {
      const {
        run,
        transcript,
      } = hydraId()
      const path = transcript({
        name: 's9.jsonl',
        from: CLAUDE,
      })
      const payload = {
        session_id: 's9',
        transcript_path: path,
        cwd: '/work',
      }
      spoolWrite({
        hydraId: 'default',
        entry: {
          v: 1,
          id: 'h0',
          at: '2026-10-11T10:59:00.000Z',
          harness: 'claude',
          event: 'SessionStart',
          payload,
        },
      })
      spoolWrite({
        hydraId: 'default',
        entry: {
          v: 1,
          id: 'h1',
          at: '2026-10-11T11:00:00.000Z',
          harness: 'claude',
          event,
          payload,
        },
      })
      writeFileSync(
        join(
          process.env.PNYX_HOME!,
          'other.json',
        ),
        '{}',
      )
      assert.match(
        run({
          args: [
            'push',
            '--key',
            'other',
            '--file',
            join(
              process.env.PNYX_HOME!,
              'other.json',
            ),
          ],
        }),
        /^ {2}notes: 6$/m,
      )
      const { state } = loadHydra({ hydraId: 'default' })
      assert.equal(
        state.cards[state.keys['claude:s9']!]!.notes?.length,
        6,
      )
    },
  )
}

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
