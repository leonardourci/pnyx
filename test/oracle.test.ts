import { fixtureCli } from './cli-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { withWriter } from '../src/store/hydra-store.ts'
import { search, updateIndex } from '../src/oracle/index.ts'
import { redact, transcriptMessages } from '../src/oracle/text.ts'

const scratch = mkdtempSync(join(
  tmpdir(),
  'pnyx-test-',
))
after(() => rmSync(
  scratch,
  {
    recursive: true,
    force: true,
  },
))

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
const TRANSCRIPT = join(
  import.meta.dirname,
  'fixtures',
  'transcripts',
  'claude-session.jsonl',
)
const CODEX = join(
  import.meta.dirname,
  'fixtures',
  'transcripts',
  'codex-session.jsonl',
)

test(
  'secret-shaped strings are redacted',
  () => {
    const text = [
      'sk-abcdefghijklmnop1234',
      'ghp_abcdefghijklmnopqrstuvwxyz',
      'github_pat_abcdefghijklmnopqrstuvwxyz',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop',
      '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
    ].join(' ')
    assert.equal(
      redact({ text }),
      Array(6).fill('[redacted]')
        .join(' '),
    )
    assert.equal(
      redact({ text: 'skip the sk- prefix' }),
      'skip the sk- prefix',
    )
  },
)

test(
  'only typed messages and assistant text are read from Claude Code and Codex transcripts',
  () => {
    const messages = ({ path }: { path: string }) => readFileSync(
      path,
      'utf8',
    ).split('\n')
      .slice(
        0,
        -1,
      )
      .flatMap(l => transcriptMessages({ record: JSON.parse(l) as unknown }))
    const texts = messages({ path: TRANSCRIPT }).map(m => m.text)
    assert.deepEqual(
      texts.slice(
        0,
        2,
      ),
      [
        'Why did the deploy get reverted after the migration?',
        'The migration locked the orders table, so the deploy was rolled back.',
      ],
    )
    const all = texts.join('\n')

    for (const hidden of [
      'toolinputword',
      'tooloutputword',
      'secretthought',
      'metaskillbody',
      'injectedreminder',
      'summaryrecordword',
    ]) {
      assert.ok(
        !all.includes(hidden),
        hidden,
      )
    }

    assert.match(
      all,
      /Use the token sk-/,
    )
    assert.deepEqual(
      messages({ path: CODEX }),
      [
        {
          at: '2026-10-12T10:00:03.000Z',
          text: 'Why is the invoice export timing out?',
        },
        {
          at: '2026-10-12T10:00:07.000Z',
          text: 'The export query scans every invoice without an index.',
        },
      ],
    )
  },
)

const cards = ({ out }: { out: string }) => [...out.matchAll(/^ {2}- card: (\S+)$/gm)].map(m => m[1])

function hydraId() {
  const home = mkdtempSync(join(
    scratch,
    'pnyx-oracle-',
  ))
  process.env.PNYX_HOME = home
  const env = {
    ...process.env,
    PNYX_HOME: home,
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
      `${key}.json`,
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

  const transcript = join(
    home,
    'session.jsonl',
  )
  copyFileSync(
    TRANSCRIPT,
    transcript,
  )
  push({
    key: 'claude:s1',
    card: {
      title: 'Orders migration',
      workspace: 'work',
      agent: {
        provider: 'claude',
        sessionId: 's1',
        transcriptPath: transcript,
      },
    },
  })
  push({
    key: 'claude:s2',
    card: {
      title: 'Checkout flake',
      workspace: 'home',
    },
  })
  run({
    args: [
      'link',
      'c2',
      '--url',
      'https://github.com/o/r/pull/42',
      '--title',
      'Fix checkout retry',
    ],
  })
  run({
    args: [
      'outcome',
      'c2',
      'done',
      '--note',
      'rolled back release 4.2',
    ],
  })

  return {
    home,
    run,
    fails,
    push,
    transcript,
  }
}

test(
  'search finds titles, links, notes and Claude Code and Codex transcript text, ranked one per card',
  () => {
    const {
      run,
      fails,
      push,
      home,
    } = hydraId()
    assert.match(
      run({
        args: [
          'oracle',
          'status',
        ],
      }),
      /^index: "none: not built yet"$/m,
    )

    const reverted = run({
      args: [
        'oracle',
        'reverted',
      ],
    })
    assert.match(
      reverted,
      /^mode: lexical$/m,
    )
    assert.match(
      reverted,
      /^results\[1\]:\n {2}- card: c1\n {4}title: Orders migration\n {4}match: lexical\n {4}snippets\[\d\]\{kind,at,snippet\}:$/m,
    )
    assert.match(
      reverted,
      /^ {6}transcript,"2026-10-11T09:00:00.000Z","Why did the deploy get \[reverted\]/m,
    )
    assert.match(
      run({
        args: [
          'oracle',
          '42',
        ],
      }),
      /^ {6}event,.*#\[42\] Fix checkout retry/m,
    )
    assert.deepEqual(
      cards({
        out: run({
          args: [
            'oracle',
            'rolled',
            'back',
          ],
        }),
      }),
      [
        'c2',
        'c1',
      ],
    )
    assert.deepEqual(
      cards({
        out: run({
          args: [
            'oracle',
            'rolled',
            'back',
            '--kind',
            'event',
          ],
        }),
      }),
      ['c2'],
    )
    assert.match(
      run({
        args: [
          'oracle',
          'migration',
          '--workspace',
          'home',
        ],
      }),
      /^results: "none: no matches for \\"migration\\""$/m,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'redacted',
        ],
      }),
      /token \[\[redacted\]\] to check/,
    )
    // The transcript's last line is torn; it is not read until it is complete.
    assert.match(
      run({
        args: [
          'oracle',
          'torntailword',
        ],
      }),
      /^results: "none: /m,
    )

    const backfill = run({
      args: [
        'oracle',
        'backfill',
        '--card',
        'claude:s1',
        '--limit',
        '2',
      ],
    })
    assert.deepEqual(
      cards({ out: backfill }),
      ['c1'],
    )
    assert.match(
      backfill,
      /^ {4}snippets\[2\]/m,
    )
    assert.match(
      backfill,
      /5 more matches; raise --limit/,
    )

    // Every word must match on one card, not in one chunk: a title word and a note word.
    const mixed = run({
      args: [
        'oracle',
        'checkout',
        'rolled',
      ],
    })
    assert.deepEqual(
      cards({ out: mixed }),
      ['c2'],
    )
    assert.match(
      mixed,
      /^ {6}event,.*"\[rolled\] back release 4\.2"$/m,
    )

    const status = run({
      args: [
        'oracle',
        'status',
      ],
    })
    assert.match(
      status,
      /^index: current through seq 5$/m,
    )
    assert.match(
      status,
      /^synonyms: "v1, 4 groups"$/m,
    )
    assert.match(
      status,
      /^ {2}tracked: 1$/m,
    )
    assert.equal(
      statSync(join(
        home,
        'hydras',
        'default',
        'search.db',
      )).mode & 0o777,
      0o600,
    )

    const codex = join(
      home,
      'rollout.jsonl',
    )
    copyFileSync(
      CODEX,
      codex,
    )
    push({
      key: 'codex:x1',
      card: {
        title: 'Invoice export',
        agent: {
          provider: 'codex',
          sessionId: 'x1',
          transcriptPath: codex,
        },
      },
    })
    const invoice = run({
      args: [
        'oracle',
        'invoice',
        'index',
      ],
    })
    assert.deepEqual(
      cards({ out: invoice }),
      ['c6'],
    )
    assert.match(
      invoice,
      /^ {6}transcript,"2026-10-12T10:00:07.000Z","The export query scans every \[invoice\] without an \[index\]\."$/m,
    )

    fails({
      args: ['oracle'],
      code: 'VALIDATION_ERROR',
    })
    fails({
      args: [
        'oracle',
        'x',
        '--kind',
        'title',
      ],
      code: 'VALIDATION_ERROR',
    })
    fails({
      args: [
        'oracle',
        'x',
        '--card',
        'nope',
      ],
      code: 'NOT_FOUND',
    })
  },
)

test(
  'a broken index is recreated from the sources, and a replaced or shortened transcript is read again from the start',
  () => {
    const {
      run,
      transcript,
      home,
    } = hydraId()
    run({
      args: [
        'oracle',
        'reverted',
      ],
    })
    writeFileSync(
      join(
        home,
        'hydras',
        'default',
        'search.db',
      ),
      'not a database',
    )
    assert.match(
      run({
        args: [
          'oracle',
          'status',
        ],
      }),
      /^index: "stale: /m,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'reverted',
        ],
      }),
      /^results\[1\]/m,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'rebuild',
        ],
      }),
      /^ {2}docs: 15$/m,
    )
    const replacement = join(
      home,
      'new.jsonl',
    )
    writeFileSync(
      replacement,
      `${JSON.stringify({
        type: 'user',
        message: { content: 'compacted summary of the outage' },
      })}\n`,
    )
    renameSync(
      replacement,
      transcript,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'reverted',
        ],
      }),
      /^results: "none: /m,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'outage',
        ],
      }),
      /^results\[1\]/m,
    )
    writeFileSync(
      transcript,
      '',
    )
    assert.match(
      run({
        args: [
          'oracle',
          'outage',
        ],
      }),
      /^results: "none: /m,
    )
  },
)

test(
  'unhighlighted snippets preserve Markdown URLs, brackets and line breaks',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      scratch,
      'pnyx-oracle-markdown-',
    ))
    const text = '[PR](https://github.com/example/project/pull/42)\n\n- **Ready** [literal].'
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
          data: {
            action: 'send',
            text,
            hydra: 'hydra',
          },
        },
      }),
    })
    updateIndex({ hydraId: 'default' })

    for (const query of [
      'project',
      'github',
    ]) {
      assert.equal(
        search({
          hydraId: 'default',
          query: {
            text: query,
            limit: 1,
            highlight: false,
          },
        }).hits[0]?.snippets[0]?.snippet,
        text,
      )
    }

    assert.match(
      search({
        hydraId: 'default',
        query: {
          text: 'project',
          limit: 1,
        },
      }).hits[0]!.snippets[0]!.snippet,
      /example\/\[project\]\/pull/,
    )
  },
)
