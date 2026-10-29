import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { ApplyError } from '#app/apply/schema.ts'
import { fakeDispatch } from '#test-harness/dispatch-fixture.ts'
import { dispatchCommands } from './dispatch-cli.ts'
import { configPath, effectiveDispatch, readTemplate, type HeadsDispatch } from './dispatch-config.ts'

type Receipt = Record<string, unknown>

function lab() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-dispatch-apply-',
  ))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  fakeDispatch({ root })
  commands.hydra([
    'create',
    'lab',
  ])

  const file = ({ value }: { value: unknown }) => {
    const path = join(
      root,
      `${randomUUID()}.json`,
    )
    writeFileSync(
      path,
      JSON.stringify(value),
    )

    return path
  }

  return { file }
}

const rule = ({ args }: { args: string[] }) => dispatchCommands.rule([
  ...args,
  '--hydra',
  'lab',
]) as Receipt

const failsWith = ({
  run,
  paths,
}: {
  run(): unknown
  paths: string[]
}) => assert.throws(
  run,
  (error: unknown) => {
    assert.ok(error instanceof ApplyError)
    assert.deepEqual(
      error.errors.map(issue => issue.path),
      paths,
    )

    return true
  },
)

test(
  'rule apply previews with --check, and a bad patch names every problem and writes nothing',
  () => {
    const { file } = lab()
    effectiveDispatch()
    const saved = readFileSync(
      configPath(),
      'utf8',
    )
    const preview = rule({
      args: [
        'apply',
        '--check',
        '--file',
        file({
          value: {
            version: 1,
            patch: { rules: { build: { candidates: [{ harness: 'claude' }] } } },
          },
        }),
      ],
    })
    assert.equal(
      preview.applied,
      false,
    )
    assert.deepEqual(
      (preview.changes as { path: string }[]).map(change => change.path),
      ['/rules/build/candidates'],
    )
    failsWith({
      run: () => rule({
        args: [
          'apply',
          '--file',
          file({
            value: {
              version: 2,
              patch: [],
              extra: true,
            },
          }),
        ],
      }),
      paths: [
        '/extra',
        '/version',
        '/patch',
      ],
    })
    failsWith({
      run: () => rule({
        args: [
          'apply',
          '--file',
          file({
            value: {
              version: 1,
              patch: {
                rules: {
                  build: {
                    candidates: [
                      {
                        harness: 'claude',
                        effort: 'ultra',
                      },
                    ],
                  },
                },
                main: 'claude:gone',
              },
            },
          }),
        ],
      }),
      paths: [
        '/rules/build/candidates/0/effort',
        '/main',
      ],
    })
    assert.equal(
      readFileSync(
        configPath(),
        'utf8',
      ),
      saved,
    )
  },
)

test(
  'rule apply saves the whole patch at once, refuses a stale revision and answers a retried event id with its first receipt',
  () => {
    const { file } = lab()
    const patch = file({
      value: {
        version: 1,
        expected: { revision: 0 },
        patch: {
          rules: {
            docs: {
              when: 'Documentation',
              candidates: [{ harness: 'codex' }],
            },
          },
          accounts: {
            'codex:docs': {
              provider: 'codex',
              folder: '~/.codex-docs',
            },
          },
          workers: { codex: ['codex:docs'] },
        },
      },
    })
    const saved = rule({
      args: [
        'apply',
        '--file',
        patch,
        '--event-id',
        'docs-1',
      ],
    })
    assert.equal(
      saved.revision,
      1,
    )
    const { dispatch } = effectiveDispatch()
    assert.equal(
      dispatch.rules.docs?.when,
      'Documentation',
    )
    assert.deepEqual(
      dispatch.workers.codex,
      ['codex:docs'],
    )
    assert.deepEqual(
      rule({
        args: [
          'apply',
          '--file',
          patch,
          '--event-id',
          'docs-1',
        ],
      }),
      {
        ...JSON.parse(JSON.stringify(saved)) as Receipt,
        duplicate: true,
      },
    )
    assert.throws(
      () => rule({
        args: [
          'apply',
          '--file',
          file({
            value: {
              version: 1,
              patch: { main: 'codex:docs' },
            },
          }),
          '--event-id',
          'docs-1',
        ],
      }),
      /already used with different contents/,
    )
    assert.throws(
      () => rule({
        args: [
          'apply',
          '--file',
          patch,
        ],
      }),
      /revision 1, not 0/,
    )
    assert.throws(
      () => rule({
        args: [
          'set',
          'docs',
          '--harness',
          'claude',
          '--if-revision',
          '0',
        ],
      }),
      /revision 1, not 0/,
    )
  },
)

test(
  'single-candidate flags keep a rule’s fallbacks; an effort the harness lacks and an account an order names are refused',
  () => {
    lab()
    const template = readTemplate() as unknown as HeadsDispatch
    rule({
      args: [
        'set',
        'build',
        '--effort',
        'xhigh',
      ],
    })
    assert.deepEqual(
      effectiveDispatch().dispatch.rules.build?.candidates,
      [
        {
          ...template.rules.build!.candidates[0]!,
          effort: 'xhigh',
        },
        template.rules.build!.candidates[1]!,
      ],
    )
    failsWith({
      run: () => rule({
        args: [
          'set',
          'build',
          '--harness',
          'codex',
          '--effort',
          'max',
        ],
      }),
      paths: ['/rules/build/candidates/0/effort'],
    })
    failsWith({
      run: () => dispatchCommands.account([
        'remove',
        'codex:test',
        '--hydra',
        'lab',
      ]),
      paths: ['/workers/codex/0'],
    })
  },
)

test(
  'Hydra proposes; queued proposals each confirm, and one whose values changed shows out of date and only dismisses',
  () => {
    lab()
    const hydra = ({ args }: { args: string[] }) => rule({
      args: [
        ...args,
        '--actor',
        'hydra',
      ],
    })
    assert.throws(
      () => hydra({
        args: [
          'set',
          'docs',
          '--harness',
          'codex',
        ],
      }),
      /Hydra must propose/,
    )
    const [
      docs,
      review,
      build,
    ] = [
      [
        'set',
        'docs',
        '--when',
        'Documentation',
        '--harness',
        'codex',
      ],
      [
        'set',
        'review',
        '--when',
        'Review',
        '--harness',
        'claude',
      ],
      [
        'set',
        'build',
        '--effort',
        'low',
      ],
    ].map(args => hydra({
      args: [
        'propose',
        ...args,
      ],
    }).token as string)
    rule({
      args: [
        'set',
        'build',
        '--effort',
        'medium',
      ],
    })
    assert.deepEqual(
      (rule({ args: ['list'] }).proposals as {
        token: string
        outOfDate: boolean
      }[])
        .map(proposal => [
          proposal.token,
          proposal.outOfDate,
        ]),
      [
        [
          docs,
          false,
        ],
        [
          review,
          false,
        ],
        [
          build,
          true,
        ],
      ],
    )

    for (const token of [
      docs!,
      review!,
    ]) {
      assert.equal(
        rule({
          args: [
            'confirm',
            token,
            '--confirm',
            token,
          ],
        }).state,
        'confirmed',
      )
    }

    const { rules } = effectiveDispatch().dispatch
    assert.equal(
      rules.docs?.candidates[0]?.harness,
      'codex',
    )
    assert.equal(
      rules.review?.when,
      'Review',
    )
    assert.throws(
      () => rule({
        args: [
          'confirm',
          build!,
          '--confirm',
          build!,
        ],
      }),
      /out of date/,
    )
    assert.equal(
      rule({
        args: [
          'dismiss',
          build!,
        ],
      }).state,
      'dismissed',
    )
    assert.equal(
      rules.build?.candidates[0]?.effort,
      'medium',
    )
  },
)
