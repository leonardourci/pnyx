import { fixtureCli } from './cli-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { withWriter } from '../src/store/hydra-store.ts'
import type { HydraEvent } from '../src/core/model.ts'
import { ftsQuery, search, updateIndex } from '../src/oracle/index.ts'
import { chunk, eventText, redact, transcriptMessages } from '../src/oracle/text.ts'

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

// Semantic search is on by default; these tests never start its worker or fetch models.
process.env.PNYX_SEMANTIC = 'off'

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
  'a short message is one chunk; a long one splits on paragraphs, keeps code fences whole and cuts overlong lines',
  () => {
    assert.deepEqual(
      chunk({ text: '  one line  ' }),
      ['one line'],
    )
    assert.deepEqual(
      chunk({ text: ' \n ' }),
      [],
    )
    const paragraphs = Array.from(
      { length: 6 },
      (
        _,
        i,
      ) => `Paragraph ${i} ${'word '.repeat(50).trim()}`,
    )
    const chunks = chunk({ text: paragraphs.join('\n\n') })
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every(c => c.length <= 768))
    assert.equal(
      chunks[1]!.split('\n\n')[0],
      chunks[0]!.split('\n\n').at(-1),
    )

    for (const p of paragraphs) {
      assert.ok(chunks.some(c => c.includes(p)))
    }

    const fence = '```\na\n\nb\n```'
    assert.ok(chunk({ text: `${'intro '.repeat(120)}\n\n${fence}` }).some(c => c.includes(fence)))
    assert.deepEqual(
      chunk({ text: 'x'.repeat(2000) }).map(c => c.length),
      [
        768,
        768,
        464,
      ],
    )
  },
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

test(
  "an event's text is what it changed",
  () => {
    const base = {
      v: 1,
      seq: 2,
      id: 'e2',
      at: '2026-10-13T00:00:00Z',
      actor: 'cli',
      cardId: 'c1',
    } as const
    const update = {
      ...base,
      type: 'card.pushed',
      data: {
        key: 'k',
        title: 'Same title',
        tags: [
          'a',
          'b',
        ],
        attention: [
          {
            kind: 'question',
            key: 'q1',
            blocking: true,
            text: 'Which region?',
          },
        ],
        before: { tags: ['a'] },
      },
    } as HydraEvent
    assert.equal(
      eventText({ event: update }),
      'b',
    )
    const created = {
      ...update,
      data: {
        ...update.data,
        before: undefined,
      },
    } as HydraEvent
    assert.equal(
      eventText({ event: created }),
      'Same title\na\nb\nWhich region?',
    )
    const link = {
      url: 'https://github.com/o/r/pull/7',
      kind: 'github_pr',
      number: 7,
      title: 'Fix it',
    } as const
    const linked = {
      ...base,
      type: 'card.linked',
      data: {
        url: link.url,
        before: null,
        after: link,
      },
    } as HydraEvent
    assert.equal(
      eventText({ event: linked }),
      '#7 Fix it https://github.com/o/r/pull/7',
    )
    const merged = {
      ...linked,
      data: {
        url: link.url,
        before: link,
        after: {
          ...link,
          state: 'merged',
        },
      },
    } as HydraEvent
    assert.equal(
      eventText({ event: merged }),
      '',
    )
    const moved = {
      ...base,
      type: 'card.moved',
      reason: 'Keep in review',
      data: {
        before: null,
        after: 'review',
      },
    } as HydraEvent
    assert.equal(
      eventText({ event: moved }),
      'Keep in review',
    )
  },
)

test(
  'query words are quoted, and words and phrases in a synonym group match the whole group',
  () => {
    for (const [
      text,
      query,
    ] of [
        [
          'Rollback the pull request',
          '("rollback" OR "revert") AND "the" AND ("pr" OR "pull request")',
        ],
        [
          '(pull request), lunch',
          '("pr" OR "pull request") AND "lunch"',
        ],
        [
          'ship*',
          '"ship"*',
        ],
        [
          'fix "AND" -x pull/7 deplo* :',
          '"fix" AND """AND""" AND "-x" AND "pull/7" AND "deplo"*',
        ],
        [
          ' - : ',
          '',
        ],
      ]) {
      assert.equal(
        ftsQuery({ text: text! }),
        query,
      )
    }
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
      /^semantic: "off: run `pnyx-axi settings set oracle.semantic on` to turn it on"$/m,
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
  'words from different entries of one card match the card, and --card matches one entry',
  () => {
    const {
      run,
      push,
      home,
    } = hydraId()
    const session = join(
      home,
      's2.jsonl',
    )
    writeFileSync(
      session,
      `${JSON.stringify({
        type: 'user',
        timestamp: '2026-10-12T08:00:00.000Z',
        message: { content: 'The checkout call hit a timeout' },
      })}\n`,
    )
    push({
      key: 'claude:s2',
      card: {
        title: 'Checkout flake',
        workspace: 'home',
        agent: {
          provider: 'claude',
          sessionId: 's2',
          transcriptPath: session,
        },
      },
    })
    const spread = run({
      args: [
        'oracle',
        'rolled',
        'timeout',
      ],
    })
    assert.deepEqual(
      cards({ out: spread }),
      ['c2'],
    )
    assert.match(
      spread,
      /^ {4}snippets\[2\]\{kind,at,snippet\}:$/m,
    )
    assert.match(
      spread,
      /\[rolled\] back release/,
    )
    assert.match(
      spread,
      /hit a \[timeout\]/,
    )
    // With --card a title word matches only the entries that carry it, not every chunk of the card.
    const titled = run({
      args: [
        'oracle',
        'checkout',
        '--card',
        'c2',
      ],
    })
    assert.match(
      titled,
      /^ {4}snippets\[3\]/m,
    )
    assert.doesNotMatch(
      titled,
      /more matches/,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'rolled',
          'timeout',
          '--card',
          'c2',
        ],
      }),
      /^results: "none: /m,
    )
  },
)

test(
  'each search indexes what the log and transcripts gained, including renamed cards and links',
  () => {
    const {
      run,
      push,
      transcript,
    } = hydraId()
    run({
      args: [
        'oracle',
        'reverted',
      ],
    })
    push({
      key: 'claude:s3',
      card: { title: 'Canary rollout' },
    })
    push({
      key: 'claude:s2',
      card: {
        title: 'Checkout retries',
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
        'Harden payments',
      ],
    })
    assert.match(
      run({
        args: [
          'oracle',
          'status',
        ],
      }),
      /^index: "behind: through seq 5 of 8; the next search catches up"$/m,
    )
    appendFileSync(
      transcript,
      `}}\n${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Canary is green',
            },
          ],
        },
      })}\n`,
    )
    assert.deepEqual(
      cards({
        out: run({
          args: [
            'oracle',
            'canary',
          ],
        }),
      }).sort(),
      [
        'c1',
        'c6',
      ],
    )
    assert.deepEqual(
      cards({
        out: run({
          args: [
            'oracle',
            'torntailword',
          ],
        }),
      }),
      ['c1'],
    )
    assert.match(
      run({
        args: [
          'oracle',
          'retries',
          'rolled',
        ],
      }),
      /^ {2}- card: c2\n {4}title: Checkout retries$/m,
    )
    assert.deepEqual(
      cards({
        out: run({
          args: [
            'oracle',
            'payments',
            'rolled',
          ],
        }),
      }),
      ['c2'],
    )
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
  'words match by stem, case, accents, synonyms and prefixes; with no match, typos and partial words match the nearest words',
  () => {
    const {
      run,
      push,
    } = hydraId()
    push({
      key: 'claude:s3',
      card: { title: 'Migração do banco' },
    })
    push({
      key: 'claude:s4',
      card: { title: 'Retryable error' },
    })
    const found = ({ args }: { args: string[] }) => cards({
      out: run({
        args: [
          'oracle',
          ...args,
        ],
      }),
    }).sort()

    for (const [
      args,
      expected,
    ] of [
        [
          [
            'deploying',
            'migrations',
          ],
          ['c1'],
        ],
        [
          ['MIGRACAO'],
          ['c5'],
        ],
        // deploy, release and ship are one group: the transcript's deploy and the note's release.
        [
          ['ship'],
          [
            'c1',
            'c2',
          ],
        ],
        // FTS5 stems "retry"* to retri*, which misses retryable; the indexed words fill the gap.
        [
          ['retry*'],
          [
            'c2',
            'c6',
          ],
        ],
        [
          ['ckout'],
          ['c2'],
        ],
        [
          [
            'chekout',
            'relese',
          ],
          ['c2'],
        ],
        [
          [
            'chekout',
            'migratoin',
          ],
          [],
        ],
      ] as const) {
      assert.deepEqual(
        found({ args: [...args] }),
        expected,
        args.join(' '),
      )
    }

    const typo = run({
      args: [
        'oracle',
        'chekout',
      ],
    })
    assert.match(
      typo,
      /^mode: fuzzy$/m,
    )
    assert.match(
      typo,
      /^results\[1\]:\n {2}- card: c2\n {4}title: Checkout flake\n {4}match: fuzzy$/m,
    )
    assert.match(
      typo,
      /\[checkout\] retry/,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'zzqqxx',
        ],
      }),
      /^results: "none: /m,
    )
  },
)

test(
  'Hydra messages and its live transcript are searchable as the Hydra, without a task, including after rebuild',
  () => {
    const {
      run,
      home,
      push,
    } = hydraId()
    run({
      args: [
        'hydra',
        'create',
        'default',
      ],
    })
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
            data: {
              action: 'send',
              text: 'I will review the layout after lunch.',
              hydra: 'hydra',
            },
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
            data: {
              session: 'hydra',
              nativeId: '0',
              role: 'assistant',
              text: 'The lunchtime review is ready.',
            },
          },
        })
      },
    })
    const lunch = run({
      args: [
        'oracle',
        'lunch',
      ],
    })
    assert.match(
      lunch,
      /card: \$board\n {4}title: Hydra\n {4}kind: hydra/,
    )
    assert.match(
      lunch,
      /after \[lunch\]/,
    )
    assert.doesNotMatch(
      lunch,
      /pnyx-axi card \$board/,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'lunchtime',
          '--kind',
          'transcript',
        ],
      }),
      /kind: hydra/,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'lunch',
          '--workspace',
          'work',
        ],
      }),
      /^results: "none: /m,
    )

    // The Hydra's own session joins its conversation as soon as it is set, before a turn-end hook.
    const transcript = join(
      home,
      'hydra.jsonl',
    )
    writeFileSync(
      transcript,
      '',
    )
    push({
      key: 'claude:hydra-live',
      card: {
        agent: {
          provider: 'claude-code',
          sessionId: 'hydra-live',
          transcriptPath: transcript,
        },
        source: {
          adapter: 'hooks',
          objectId: 'hydra-live',
        },
      },
    })
    run({
      args: [
        'oracle',
        'rebuild',
      ],
    })
    assert.match(
      run({
        args: [
          'oracle',
          'lunch',
        ],
      }),
      /kind: hydra/,
    )
    run({
      args: [
        'hydra',
        'set',
        '--session',
        'claude-code:hydra-live',
      ],
    })
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        message: { content: 'The flamingo investigation is ready.' },
      })}\n`,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'flamingo',
        ],
      }),
      /card: \$board\n {4}title: Hydra\n {4}kind: hydra/,
    )
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        message: { content: 'The canary review is ready.' },
      })}\n`,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'flamingo',
        ],
      }),
      /^results: "none: /m,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'canary',
        ],
      }),
      /kind: hydra/,
    )
  },
)

test(
  'live Hydra searches exclude hidden sessions before applying the result limit',
  () => {
    const {
      run,
      push,
    } = hydraId()
    run({
      args: [
        'hydra',
        'create',
        'default',
      ],
    })
    push({
      key: 'claude:hidden',
      card: {
        title: 'Hidden flamingo session',
        agent: {
          provider: 'claude-code',
          sessionId: 'hidden',
        },
        source: {
          adapter: 'hooks',
          objectId: 'hidden',
        },
      },
    })
    run({
      args: [
        'task',
        'create',
        '--title',
        'Visible flamingo task',
      ],
    })
    updateIndex({ hydraId: 'default' })
    assert.deepEqual(
      search({
        hydraId: 'default',
        query: {
          text: 'flamingo',
          live: true,
          limit: 1,
        },
      }).hits.map(hit => hit.title),
      ['Visible flamingo task'],
    )
    assert.match(
      run({
        args: [
          'oracle',
          'flamingo',
        ],
      }),
      /Hidden flamingo session/,
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
