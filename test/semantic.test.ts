import { fixtureCli } from './cli-fixture.ts'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
const run$ = promisify(execFile)

const cards = ({ out }: { out: string }) => [...out.matchAll(/^ {2}- card: (\S+)$/gm)].map(m => m[1])

// A Hydra in a temporary home. With stub, the worker embeds with hash vectors and
// reranks by word overlap, so no model is ever downloaded or loaded.
function hydraId({ extra = {} }: { extra?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-sem-',
  ))
  const env = {
    ...process.env,
    PNYX_HOME: home,
    PNYX_SEMANTIC_STUB: '1',
    ...extra,
  }
  const cli = ({ semantic }: { semantic: boolean }) => fixtureCli({
    home,
    execute: ({ args }) => execFileSync(
      process.execPath,
      [
        BIN,
        ...args,
      ],
      {
        env: semantic ? env : {
          ...env,
          PNYX_SEMANTIC: 'off',
        },
        encoding: 'utf8',
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    ),
  })
  const run = cli({ semantic: true })
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

  push({
    key: 'a',
    card: {
      title: 'Orders migration',
      workspace: 'work',
    },
  })
  push({
    key: 'b',
    card: {
      title: 'Dark mode toggle',
      workspace: 'home',
    },
  })
  push({
    key: 'c',
    card: {
      title: 'Flaky login test',
      workspace: 'home',
    },
  })
  run({
    args: [
      'outcome',
      'c1',
      'done',
      '--note',
      'deploy reverted because the migration locked the orders table',
    ],
  })
  run({
    args: [
      'outcome',
      'c3',
      'done',
      '--note',
      'session cookie expired before the assertion',
    ],
  })
  // Turning semantic search off stops the worker within seconds.
  const stop = () => run({
    args: [
      'settings',
      'set',
      'oracle.semantic',
      'off',
    ],
  })

  return {
    home,
    env,
    run,
    lexical: cli({ semantic: false }),
    fails,
    stop,
  }
}

async function embedded({ run }: {
  run: (
    { args }: {
      args?: string[]
    },
  ) => string
}): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const status = run({
      args: [
        'oracle',
        'status',
      ],
    })
    const m = status.match(/^vectors: (\d+) of (\d+) entries embedded$/m)

    if (m && m[1] === m[2] && /^rerank: (on|off)$/m.test(status)) {
      return status
    }

    run({
      args: [
        'oracle',
        'orders',
      ],
    })
    await new Promise(resolve => setTimeout(
      resolve,
      100,
    ))
  }

  throw new Error('the worker never finished embedding')
}

test(
  'semantic search is on by default: full text with progress while the model downloads, then the machine’s models rerank and rank actions',
  async () => {
    const {
      home,
      run,
      lexical: off,
      stop,
    } = hydraId({ extra: { PNYX_SEMANTIC_STUB_DOWNLOAD_MS: '3000' } })
    process.env.PNYX_HOME = home
    process.env.PNYX_SEMANTIC_STUB = '1'
    const { matchActions } = await import('../src/oracle/semantic.ts')
    const entries = [
      {
        id: 'theme',
        text: 'Choose a dark theme for reading at night',
      },
      {
        id: 'new-task',
        text: 'Create a new task in this column',
      },
    ]

    try {
      assert.match(
        run({ args: ['settings'] }),
        /^ {2}oracle\.semantic: on\n {2}oracle\.rerank: auto\n {2}oracle\.model: auto$/m,
      )
      const lexical = off({
        args: [
          'oracle',
          'orders',
        ],
      })
      let out = run({
        args: [
          'oracle',
          'orders',
        ],
      })

      for (let i = 0; i < 20 && !/downloading/.test(out); i += 1) {
        await new Promise(resolve => setTimeout(
          resolve,
          100,
        ))
        out = run({
          args: [
            'oracle',
            'orders',
          ],
        })
      }

      assert.match(
        out,
        /^semantic: "downloading the model, \d+% of 347 MB; full-text results until it is ready"$/m,
      )
      assert.equal(
        out.replace(
          /^semantic: .*\n/m,
          '',
        ),
        lexical,
      )
      assert.match(
        run({
          args: [
            'oracle',
            'status',
          ],
        }),
        /^semantic: "preparing \(stub\): downloading the model, \d+% of 347 MB; full-text results until it is ready"$/m,
      )

      const status = await embedded({ run })
      // The stub counts as a GPU machine: the 311m-sized stub embedder and the reranker.
      assert.match(
        status,
        /^semantic: "on: granite-311m on stub, 64 dimensions"$/m,
      )
      assert.match(
        status,
        /^rerank: on$/m,
      )
      // The stub reranker scores the share of query words a card's nearest entry holds.
      const strong = run({
        args: [
          'oracle',
          'session',
          'cookie',
          'expired',
        ],
      })
      assert.match(
        strong,
        /^mode: "hybrid, reranked"$/m,
      )
      assert.equal(
        cards({ out: strong })[0],
        'c3',
      )
      assert.doesNotMatch(
        strong,
        /^note:/m,
      )
      assert.match(
        strong,
        /^ {2}- card: c1\n(?: {4}.*\n)*? {4}weak: true$/m,
      )
      assert.match(
        run({
          args: [
            'oracle',
            'cookie',
            'dinosaur',
          ],
        }),
        /^note: "no strong match: /m,
      )

      for (const entry of entries) {
        assert.deepEqual(
          await matchActions({
            query: entry.text,
            entries,
          }),
          [entry.id],
        )
      }
    } finally {
      stop()
    }

    assert.deepEqual(
      await matchActions({
        query: entries[0]!.text,
        entries,
      }),
      [],
    )
  },
)

test(
  'bad settings are refused; PNYX_SEMANTIC=off turns semantic search off without changing the setting',
  async () => {
    const {
      run,
      fails,
      home,
    } = hydraId({ extra: { PNYX_SEMANTIC: 'off' } })

    for (const args of [
      [
        'settings',
        'set',
        'oracle.semantic',
        'maybe',
      ],
      [
        'settings',
        'set',
        'oracle.rerank',
        'sometimes',
      ],
      [
        'settings',
        'set',
        'oracle.model',
        'huge',
      ],
      [
        'settings',
        'set',
        'nope',
        'on',
      ],
      [
        'oracle',
        'setup',
      ],
    ]) {
      fails({
        args,
        code: 'VALIDATION_ERROR',
      })
    }

    run({
      args: [
        'settings',
        'set',
        'oracle.rerank',
        'off',
      ],
    })
    assert.match(
      readFileSync(
        join(
          home,
          'settings.json',
        ),
        'utf8',
      ),
      /"search\.semantic": "on"/,
    )
    const out = run({
      args: [
        'oracle',
        'orders',
      ],
    })
    assert.match(
      out,
      /^mode: lexical$/m,
    )
    assert.doesNotMatch(
      out,
      /^semantic:/m,
    )
    assert.match(
      run({
        args: [
          'oracle',
          'status',
        ],
      }),
      /^semantic: "off: /m,
    )
    process.env.PNYX_HOME = home
    const { workerSocket } = await import('../src/oracle/semantic.ts')
    assert.ok(
      !existsSync(workerSocket()),
      'no worker starts while semantic search is off',
    )
  },
)

test(
  'the worker socket sits in a folder only this user can use',
  { skip: process.platform === 'win32' },
  async () => {
    const tmp = mkdtempSync(join(
      tmpdir(),
      'pnyx-sock-',
    ))
    const previous = process.env.TMPDIR
    process.env.TMPDIR = tmp
    process.env.PNYX_HOME = join(
      tmp,
      'x'.repeat(200),
    )

    try {
      const { workerSocket } = await import('../src/oracle/semantic.ts')
      const dir = join(
        tmp,
        `pnyx-${process.getuid!()}`,
      )
      assert.match(
        workerSocket(),
        new RegExp(`^${dir}/semantic-[0-9a-f]{16}\\.sock$`),
      )
      assert.equal(
        statSync(dir).mode & 0o777,
        0o700,
      )
      chmodSync(
        dir,
        0o777,
      )
      assert.throws(
        () => workerSocket(),
        /must be a folder only this user can use/,
      )
    } finally {
      process.env.TMPDIR = previous
    }
  },
)

test(
  'a setup Hydra finds cards and Hydra messages by meaning and by words, re-embeds for a changed model, and turned off searches exactly as full text',
  async () => {
    const {
      run,
      lexical,
      stop,
      home,
      env,
    } = hydraId({ })
    process.env.PNYX_HOME = home
    const { withWriter } = await import('../src/store/hydra-store.ts')
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'hydra-semantic',
            at: '2026-10-15T10:00:00Z',
            actor: 'fixture',
            cardId: '$board',
            type: 'hydra.message',
            data: {
              action: 'send',
              hydra: 'hydra',
              text: 'flamingo rollout staged',
            },
          },
        })
      },
    })
    const queries = [
      ['orders'],
      [
        'reverted',
        'cookie',
      ],
      ['migraton'],
      [
        'orders',
        '--card',
        'c1',
      ],
      [
        'table',
        'dinosaur',
        '--card',
        'c1',
      ],
    ]
    const before = queries.map(q => lexical({
      args: [
        'oracle',
        ...q,
      ],
    }))
    // "reverted cookie": no card holds both words; "table dinosaur": no entry of c1 holds both.
    assert.match(
      before[1]!,
      /^mode: lexical\nresults: "none: /m,
    )
    assert.match(
      before[4]!,
      /^results: "none: /m,
    )

    try {
      const setup = run({
        args: [
          'oracle',
          'setup',
          '--semantic',
        ],
      })

      for (const line of [
        /^semantic: on$/m,
        /^mode: stub$/m,
        /^model: granite-311m$/m,
        /^rerank: on$/m,
      ]) {
        assert.match(
          setup,
          line,
        )
      }

      run({
        args: [
          'settings',
          'set',
          'oracle.rerank',
          'off',
        ],
      })
      assert.match(
        await embedded({ run }),
        /^mode: "hybrid: words fused with meaning"$/m,
      )

      // The full-text leg finds nothing; meaning finds both cards.
      const meaning = run({
        args: [
          'oracle',
          'reverted',
          'cookie',
        ],
      })
      assert.match(
        meaning,
        /^mode: hybrid$/m,
      )
      assert.match(
        meaning,
        /^semantic: "ready: granite-311m on stub"$/m,
      )
      assert.deepEqual(
        cards({ out: meaning }).slice(
          0,
          2,
        )
          .sort(),
        [
          'c1',
          'c3',
        ],
      )
      assert.match(
        meaning,
        /^ {4}match: semantic$/m,
      )
      assert.match(
        meaning,
        /^ {6}event,"[^"]+",deploy reverted because the migration locked the orders table$/m,
      )

      const both = run({
        args: [
          'oracle',
          'orders',
        ],
      })
      assert.equal(
        cards({ out: both })[0],
        'c1',
      )
      assert.match(
        both,
        /^ {4}match: both$/m,
      )
      assert.match(
        both,
        /\[orders\] table/,
      )

      const homeOnly = cards({
        out: run({
          args: [
            'oracle',
            'reverted',
            'cookie',
            '--workspace',
            'home',
          ],
        }),
      })
      assert.equal(
        homeOnly[0],
        'c3',
      )
      assert.ok(!homeOnly.includes('c1'))

      const entries = run({
        args: [
          'oracle',
          'table',
          'dinosaur',
          '--card',
          'c1',
        ],
      })
      assert.match(
        entries,
        /^ {4}match: semantic$/m,
      )
      assert.match(
        entries,
        /^ {6}event,"[^"]+",deploy reverted because the migration locked the orders table$/m,
      )
      assert.match(
        run({
          args: [
            'oracle',
            'flamingo rollout staged dinosaur',
          ],
        }),
        /kind: hydra\n {4}match: semantic/,
      )

      // Without the reranker, a card found by meaning alone is weak under the similarity floor.
      const unrelated = run({
        args: [
          'oracle',
          'dinosaur',
          'banana',
        ],
      })
      assert.equal(
        unrelated.match(/^ {4}weak: true$/gm)?.length,
        cards({ out: unrelated }).length,
      )
      const near = run({
        args: [
          'oracle',
          'session',
          'cookie',
          'expired',
          'dinosaur',
        ],
      })
      assert.equal(
        cards({ out: near })[0],
        'c3',
      )
      assert.match(
        near,
        /^ {2}- card: c3\n(?: {4}(?!weak).*\n)*(?! {4})/m,
      )
      assert.equal(
        near.match(/^ {4}weak: true$/gm)?.length,
        cards({ out: near }).length - 1,
      )

      // A changed model drops the vectors and embeds again.
      const { sqlite } = await import('../src/oracle/index.ts')
      const { DatabaseSync } = sqlite()
      const db = new DatabaseSync(join(
        home,
        'hydras',
        'default',
        'search.db',
      ))
      db.prepare("UPDATE meta SET value = 'other' WHERE key = 'embed.key'").run()
      db.close()
      assert.match(
        run({
          args: [
            'oracle',
            'status',
          ],
        }),
        /^vectors: 0 of \d+ entries embedded$/m,
      )
      await embedded({ run })

      // The one worker answers every Hydra.
      mkdirSync(
        join(
          home,
          'hydras',
          'second',
        ),
        { recursive: true },
      )
      writeFileSync(
        join(
          home,
          'hydras',
          'second',
          'events.jsonl',
        ),
        '',
      )
      assert.match(
        (await run$(
          process.execPath,
          [
            BIN,
            'oracle',
            'anything',
            '--hydra',
            'second',
          ],
          { env },
        )).stdout,
        /^results: "none: /m,
      )
    } finally {
      stop()
    }

    assert.deepEqual(
      queries.map(q => run({
        args: [
          'oracle',
          ...q,
        ],
      })),
      before,
    )
  },
)

test(
  'a recorded reranker failure keeps search on the embedder alone, a semantic failure keeps it full-text, until setup clears both',
  async () => {
    const {
      run,
      home,
      stop,
    } = hydraId({ })
    const fail = ({
      file,
      message,
    }: {
      file: string
      message: string
    }) => writeFileSync(
      join(
        home,
        file,
      ),
      JSON.stringify({
        message,
        until: Date.now() + 60_000,
      }),
    )

    try {
      fail({
        file: 'reranker-failure.json',
        message: 'download of r failed: HTTP 503',
      })
      let status = ''

      for (let i = 0; i < 100 && !/^vectors: (\d+) of \1 /m.test(status); i += 1) {
        run({
          args: [
            'oracle',
            'orders',
          ],
        })
        await new Promise(resolve => setTimeout(
          resolve,
          100,
        ))
        status = run({
          args: [
            'oracle',
            'status',
          ],
        })
      }

      assert.match(
        status,
        /^rerank: "the reranker failed: download of r failed: HTTP 503"$/m,
      )
      assert.match(
        run({
          args: [
            'oracle',
            'orders',
          ],
        }),
        /^mode: hybrid$/m,
      )
      fail({
        file: 'semantic-failure.json',
        message: 'download of x failed: HTTP 503',
      })
      const out = run({
        args: [
          'oracle',
          'orders',
        ],
      })
      assert.match(
        out,
        /^semantic: "unavailable: download of x failed: HTTP 503; run `pnyx-axi oracle setup --semantic` to retry now"$/m,
      )
      assert.match(
        out,
        /^mode: lexical$/m,
      )
      assert.match(
        run({
          args: [
            'oracle',
            'setup',
            '--semantic',
          ],
        }),
        /^semantic: on$/m,
      )

      for (const file of [
        'reranker-failure.json',
        'semantic-failure.json',
      ]) {
        assert.ok(
          !existsSync(join(
            home,
            file,
          )),
          file,
        )
      }
    } finally {
      stop()
    }
  },
)

test(
  'a model download is checked against its pinned size and SHA-256',
  async () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-dl-',
    ))
    const {
      download,
      modelPath,
    } = await import('../src/oracle/models.ts')
    const body = Buffer.from('not really a model')
    const server = createServer((
      _req,
      res,
    ) => res.end(body))
    await new Promise<void>(resolve => server.listen(
      0,
      '127.0.0.1',
      resolve,
    ))

    try {
      const good = {
        file: 'm.gguf',
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}/m.gguf`,
        sha256: createHash('sha256').update(body)
          .digest('hex'),
        bytes: body.length,
      }
      const bad = {
        ...good,
        file: 'bad.gguf',
        sha256: '0'.repeat(64),
      }
      await assert.rejects(
        download({ model: bad }),
        /does not match its pin/,
      )
      assert.ok(!existsSync(modelPath({ model: bad })) && !existsSync(`${modelPath({ model: bad })}.part`))
      assert.equal(
        await download({ model: good }),
        'downloaded',
      )
      assert.deepEqual(
        readFileSync(modelPath({ model: good })),
        body,
      )
      assert.equal(
        await download({ model: good }),
        'present',
      )
    } finally {
      server.close()
    }
  },
)
