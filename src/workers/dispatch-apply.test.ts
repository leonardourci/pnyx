import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { ApplyError } from '#app/apply/schema.ts'
import { fakeDispatch } from '#test-harness/dispatch-fixture.ts'
import { withWriter } from '#app/writer.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraDir } from '#app/home-migration.ts'
import { HydraError } from '#store/errors.ts'
import { withRegistryLock } from '#store/storage.ts'
import { dispatchCommands } from './dispatch-cli.ts'
import { changesPath, configPath, effectiveDispatch, readTemplate, type HeadsDispatch } from './dispatch-config.ts'
import type { DispatchDocument } from './dispatch-check.ts'
import type { ProposalStatus } from './dispatch-apply.ts'

type Receipt = Record<string, unknown>

// Well under the registry lock's 5 s wait, so a read that waited for the lock fails.
const NO_WAIT_MS = 1000

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

const show = () => rule({ args: ['show'] }) as {
  revision: number
  document: DispatchDocument
}

const dispatchFile = () => JSON.parse(readFileSync(
  configPath(),
  'utf8',
)) as HeadsDispatch

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
  'the first apply checks and reports the revision after legacy dispatch migration',
  () => {
    const { file } = lab()
    writeFileSync(
      join(
        hydraDir({ hydraId: 'lab' }),
        'heads-dispatch.json',
      ),
      JSON.stringify({
        rules: {
          legacy: {
            when: 'Old rule',
            candidates: [{ harness: 'claude' }],
          },
        },
      }),
    )
    const patch = file({
      value: {
        version: 1,
        patch: {
          rules: {
            docs: {
              when: 'Docs',
              candidates: [{ harness: 'codex' }],
            },
          },
        },
      },
    })
    assert.throws(
      () => rule({
        args: [
          'apply',
          '--file',
          patch,
          '--if-revision',
          '0',
        ],
      }),
      { code: 'REVISION_CONFLICT' },
    )
    const saved = rule({
      args: [
        'apply',
        '--file',
        patch,
        '--if-revision',
        '1',
      ],
    })
    assert.equal(
      saved.revision,
      2,
    )
    const shown = show()
    assert.equal(
      shown.revision,
      2,
    )
    assert.equal(
      shown.document.rules.legacy?.when,
      'Old rule',
    )
    assert.equal(
      shown.document.rules.docs?.when,
      'Docs',
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
      { code: 'IDEMPOTENCY_CONFLICT' },
    )
    assert.throws(
      () => rule({
        args: [
          'apply',
          '--file',
          patch,
        ],
      }),
      { code: 'REVISION_CONFLICT' },
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
      { code: 'REVISION_CONFLICT' },
    )
  },
)

test(
  'a retried event id whose first attempt changed nothing returns that receipt and never reapplies after a later edit',
  () => {
    const { file } = lab()
    const template = readTemplate() as unknown as HeadsDispatch
    const unchanged = file({
      value: {
        version: 1,
        patch: { rules: { build: { when: template.rules.build!.when } } },
      },
    })
    const retry = ({ path }: { path: string }) => rule({
      args: [
        'apply',
        '--file',
        path,
        '--event-id',
        'retry-noop',
      ],
    })
    assert.deepEqual(
      retry({ path: unchanged }),
      {
        event: 'none: unchanged',
        revision: 0,
      },
    )
    rule({
      args: [
        'set',
        'build',
        '--when',
        'Later owner change',
      ],
    })
    assert.deepEqual(
      retry({ path: unchanged }),
      {
        event: 'none: unchanged',
        revision: 0,
        duplicate: true,
      },
    )
    assert.equal(
      show().document.rules.build?.when,
      'Later owner change',
    )
    assert.equal(
      show().revision,
      1,
    )
    assert.throws(
      () => retry({
        path: file({
          value: {
            version: 1,
            patch: { rules: { build: { when: 'Other wording' } } },
          },
        }),
      }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    )
  },
)

test(
  'a save the change log refuses leaves both files and the revision as they were',
  () => {
    lab()
    show()
    const dispatch = readFileSync(
      configPath(),
      'utf8',
    )
    const accounts = readFileSync(
      configPath({ accounts: true }),
      'utf8',
    )
    chmodSync(
      changesPath(),
      0o400,
    )

    try {
      assert.throws(
        () => rule({
          args: [
            'set',
            'build',
            '--when',
            'Unsaved wording',
          ],
        }),
        { code: 'EACCES' },
      )
    } finally {
      chmodSync(
        changesPath(),
        0o600,
      )
    }

    assert.equal(
      readFileSync(
        configPath(),
        'utf8',
      ),
      dispatch,
    )
    assert.equal(
      readFileSync(
        configPath({ accounts: true }),
        'utf8',
      ),
      accounts,
    )
    assert.equal(
      show().revision,
      0,
    )
  },
)

test(
  'a save cut short between its two file renames reads as the logged change and rewrites the stale file',
  () => {
    const { file } = lab()
    const before = readFileSync(
      configPath(),
      'utf8',
    )
    rule({
      args: [
        'apply',
        '--file',
        file({
          value: {
            version: 1,
            patch: {
              accounts: {
                'codex:docs': {
                  provider: 'codex',
                  folder: '~/.codex-docs',
                },
              },
              workers: { codex: ['codex:docs'] },
            },
          },
        }),
      ],
    })
    // The accounts file is renamed first, so a crash before the second rename leaves the old dispatch file.
    writeFileSync(
      configPath(),
      before,
    )
    assert.deepEqual(
      effectiveDispatch().dispatch.workers.codex,
      ['codex:docs'],
    )
    assert.deepEqual(
      dispatchFile().workers.codex,
      ['codex:docs'],
    )
    assert.equal(
      show().revision,
      1,
    )
  },
)

test(
  'a change log line cut short is not saved: reads return the change before it and its event id applies again',
  () => {
    const { file } = lab()
    rule({
      args: [
        'set',
        'build',
        '--when',
        'First wording',
      ],
    })
    const second = file({
      value: {
        version: 1,
        patch: { rules: { build: { when: 'Second wording' } } },
      },
    })
    const apply = () => rule({
      args: [
        'apply',
        '--file',
        second,
        '--event-id',
        'second',
      ],
    })
    apply()
    const [
      first,
      torn,
    ] = readFileSync(
      changesPath(),
      'utf8',
    ).split('\n')
    writeFileSync(
      changesPath(),
      `${first}\n${torn!.slice(
        0,
        6,
      )}`,
    )
    const {
      document,
      revision,
    } = show()
    assert.equal(
      revision,
      1,
    )
    assert.equal(
      document.rules.build?.when,
      'First wording',
    )
    assert.equal(
      dispatchFile().rules.build?.when,
      'First wording',
    )
    const retried = apply()
    assert.deepEqual(
      [
        retried.revision,
        retried.duplicate,
      ],
      [
        2,
        undefined,
      ],
    )
    assert.equal(
      show().document.rules.build?.when,
      'Second wording',
    )
  },
)

test(
  'a read while another holder has the registry lock returns the logged document at once and leaves the files for later',
  () => {
    lab()
    rule({
      args: [
        'set',
        'build',
        '--when',
        'Logged wording',
      ],
    })
    rmSync(configPath())
    const started = performance.now()
    const when = withRegistryLock({ fn: () => effectiveDispatch().dispatch.rules.build?.when })
    assert.ok(performance.now() - started < NO_WAIT_MS)
    assert.equal(
      when,
      'Logged wording',
    )
    assert.equal(
      existsSync(configPath()),
      false,
    )
    effectiveDispatch()
    assert.equal(
      dispatchFile().rules.build?.when,
      'Logged wording',
    )
  },
)

test(
  'an unreadable line inside the change log is reported and skipped, and the lines around it still count',
  t => {
    lab()
    rule({
      args: [
        'set',
        'build',
        '--when',
        'First wording',
      ],
    })
    rule({
      args: [
        'set',
        'build',
        '--when',
        'Second wording',
      ],
    })
    const [
      first,
      second,
    ] = readFileSync(
      changesPath(),
      'utf8',
    ).split('\n')
    writeFileSync(
      changesPath(),
      `${first}\nnot json\n${second}\n`,
    )
    const reported = t.mock.method(
      console,
      'error',
      () => {},
    )
    const {
      document,
      revision,
    } = show()
    assert.deepEqual(
      [
        document.rules.build?.when,
        revision,
      ],
      [
        'Second wording',
        2,
      ],
    )
    assert.deepEqual(
      reported.mock.calls.map(call => call.arguments),
      [[`pnyx-axi: skipped 1 unreadable lines in ${changesPath()}`]],
    )
  },
)

test(
  'deleting every rule saves an empty rules object later reads keep, and the default list cannot be removed',
  () => {
    const { file } = lab()
    rule({
      args: [
        'apply',
        '--file',
        file({
          value: {
            version: 1,
            patch: {
              rules: {
                mechanical: null,
                build: null,
                investigate: null,
              },
            },
          },
        }),
      ],
    })
    assert.deepEqual(
      show().document.rules,
      {},
    )
    rmSync(configPath())
    assert.deepEqual(
      effectiveDispatch().dispatch.rules,
      {},
    )
    assert.deepEqual(
      dispatchFile().rules,
      {},
    )
    failsWith({
      run: () => rule({
        args: [
          'apply',
          '--file',
          file({
            value: {
              version: 1,
              patch: { default: null },
            },
          }),
        ],
      }),
      paths: ['/default'],
    })
  },
)

const refuses = ({
  patch,
  paths,
}: {
  patch: Record<string, unknown>
  paths: string[]
}) => {
  const { file } = lab()
  failsWith({
    run: () => rule({
      args: [
        'apply',
        '--file',
        file({
          value: {
            version: 1,
            patch,
          },
        }),
      ],
    }),
    paths,
  })
}

test(
  'a patch cannot remove the rules section',
  () => refuses({
    patch: { rules: null },
    paths: ['/rules'],
  }),
)

test(
  'a patch cannot remove the accounts section, even when main and orders name only the harness logins',
  () => refuses({
    patch: {
      accounts: null,
      main: 'claude:default',
      workers: {
        claude: ['claude:default'],
        codex: null,
      },
    },
    paths: ['/accounts'],
  }),
)

test(
  'a patch cannot remove the workers section',
  () => refuses({
    patch: { workers: null },
    paths: ['/workers'],
  }),
)

test(
  'a patch cannot remove the projects section',
  () => refuses({
    patch: { projects: null },
    paths: ['/projects'],
  }),
)

test(
  'removing the last account is refused while main or an order names it, and the harness logins stand in once none is registered',
  () => {
    const { file } = lab()
    dispatchCommands.account([
      'remove',
      'codex:test',
      '--hydra',
      'lab',
    ])
    failsWith({
      run: () => rule({
        args: [
          'apply',
          '--file',
          file({
            value: {
              version: 1,
              patch: { accounts: { 'claude:test': null } },
            },
          }),
        ],
      }),
      paths: [
        '/main',
        '/workers/claude/0',
      ],
    })
    rule({
      args: [
        'apply',
        '--file',
        file({
          value: {
            version: 1,
            patch: {
              accounts: { 'claude:test': null },
              main: 'claude:default',
              workers: { claude: ['claude:default'] },
            },
          },
        }),
      ],
    })
    const { document } = show()
    assert.deepEqual(
      [
        document.accounts,
        document.main,
        document.workers,
      ],
      [
        {},
        'claude:default',
        { claude: ['claude:default'] },
      ],
    )
  },
)

test(
  'single-candidate flags keep a rule’s fallbacks, an effort the harness lacks is refused, and a removed account leaves every order',
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
        'claude:test',
        '--hydra',
        'lab',
      ]),
      paths: ['/main'],
    })
    dispatchCommands.account([
      'remove',
      'codex:test',
      '--hydra',
      'lab',
    ])
    assert.equal(
      effectiveDispatch().dispatch.workers.codex,
      undefined,
    )
  },
)

test(
  'a proposal checked against a revision confirms only the values it showed, keeping a later change to the same rule',
  () => {
    lab()
    const { revision } = rule({ args: ['show'] }) as { revision: number }
    const { token } = rule({
      args: [
        'propose',
        'set',
        'build',
        '--effort',
        'low',
        '--if-revision',
        String(revision),
        '--actor',
        'hydra',
      ],
    }) as { token: string }
    rule({
      args: [
        'set',
        'build',
        '--when',
        'Owner wording',
      ],
    })
    rule({
      args: [
        'confirm',
        token,
        '--confirm',
        token,
      ],
    })
    const build = effectiveDispatch().dispatch.rules.build
    assert.equal(
      build?.when,
      'Owner wording',
    )
    assert.equal(
      build?.candidates[0]?.effort,
      'low',
    )
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
      effectiveDispatch().dispatch.rules.build?.candidates[0]?.effort,
      'medium',
    )
    assert.deepEqual(
      rule({ args: ['list'] }).proposals,
      [],
    )
  },
)

test(
  'a proposal that no longer checks, and one saved before proposals held patches, cannot be confirmed',
  () => {
    lab()
    const account = ({ args }: { args: string[] }) => dispatchCommands.account([
      ...args,
      '--hydra',
      'lab',
    ])
    account({
      args: [
        'set',
        'codex:docs',
        '--provider',
        'codex',
        '--folder',
        '~/.codex-docs',
      ],
    })
    const { token } = rule({
      args: [
        'propose',
        'accounts',
        '--main',
        'codex:docs',
        '--actor',
        'hydra',
      ],
    }) as { token: string }
    account({
      args: [
        'remove',
        'codex:docs',
      ],
    })
    assert.deepEqual(
      (rule({ args: ['list'] }).proposals as ProposalStatus[]).map(({
        outOfDate,
        reason,
      }) => ({
        outOfDate,
        reason,
      })),
      [
        {
          outOfDate: true,
          reason: 'This proposal no longer checks: /main codex:docs is not a registered account',
        },
      ],
    )
    assert.throws(
      () => rule({
        args: [
          'confirm',
          token,
          '--confirm',
          token,
        ],
      }),
      /no longer checks/,
    )
    assert.equal(
      effectiveDispatch().dispatch.main,
      'claude:test',
    )
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            at: new Date().toISOString(),
            actor: 'hydra',
          },
          cardId: HYDRA_CARD,
          change: {
            type: 'hydra.dispatch-proposed',
            data: {
              token: 'old-proposal',
              kind: 'rule',
              shared: true,
              before: '{}',
              value: '{"default":[{"harness":"codex"}]}',
              summary: 'Rule set default (shared)',
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    assert.equal(
      (rule({ args: ['list'] }).proposals as {
        token: string
        outOfDate: boolean
      }[])
        .find(proposal => proposal.token === 'old-proposal')?.outOfDate,
      true,
    )
    assert.throws(
      () => rule({
        args: [
          'confirm',
          'old-proposal',
          '--confirm',
          'old-proposal',
        ],
      }),
      /out of date/,
    )
    assert.equal(
      rule({
        args: [
          'dismiss',
          'old-proposal',
        ],
      }).state,
      'dismissed',
    )
    assert.deepEqual(
      effectiveDispatch().dispatch.default,
      [{ harness: 'claude' }],
    )
  },
)

test(
  'a confirm whose save landed but whose resolution was not recorded only records it when retried',
  () => {
    lab()
    const { token } = rule({
      args: [
        'propose',
        'set',
        'build',
        '--effort',
        'low',
        '--actor',
        'hydra',
      ],
    }) as { token: string }
    const confirm = () => rule({
      args: [
        'confirm',
        token,
        '--confirm',
        token,
      ],
    })
    const events = join(
      hydraDir({ hydraId: 'lab' }),
      'events.jsonl',
    )
    chmodSync(
      events,
      0o400,
    )

    try {
      assert.throws(
        confirm,
        { code: 'EACCES' },
      )
    } finally {
      chmodSync(
        events,
        0o600,
      )
    }

    assert.equal(
      confirm().state,
      'confirmed',
    )
    const {
      document,
      revision,
    } = show()
    assert.deepEqual(
      [
        document.rules.build?.candidates[0]?.effort,
        revision,
      ],
      [
        'low',
        1,
      ],
    )
    assert.deepEqual(
      rule({ args: ['list'] }).proposals,
      [],
    )
  },
)

test(
  'an error an older Pnyx saved still reads, and a patch may fix it but not add another',
  () => {
    const { file } = lab()
    const saved = JSON.parse(readFileSync(
      configPath(),
      'utf8',
    )) as Record<string, unknown>
    writeFileSync(
      configPath(),
      JSON.stringify({
        ...saved,
        rules: {
          docs: {
            when: 'Documentation',
            candidates: [
              {
                harness: 'codex',
                effort: 'max',
              },
            ],
          },
        },
      }),
    )
    assert.equal(
      effectiveDispatch().dispatch.rules.docs?.candidates[0]?.effort,
      'max',
    )
    assert.match(
      String(rule({ args: ['show'] }).issues),
      /error \/rules\/docs\/candidates\/0\/effort/,
    )
    rule({
      args: [
        'apply',
        '--file',
        file({
          value: {
            version: 1,
            patch: {
              rules: {
                review: {
                  when: 'Review',
                  candidates: [{ harness: 'claude' }],
                },
              },
            },
          },
        }),
      ],
    })
    failsWith({
      run: () => rule({
        args: [
          'set',
          'review',
          '--effort',
          'ultra',
        ],
      }),
      paths: ['/rules/review/candidates/0/effort'],
    })
    rule({
      args: [
        'set',
        'docs',
        '--effort',
        'xhigh',
      ],
    })
    assert.deepEqual(
      rule({ args: ['show'] }).issues,
      [],
    )
  },
)

test(
  'a merged rule with a bad name stops reads with the rule apply hint until a patch removes it, and a patch cannot add another',
  () => {
    const { file } = lab()
    writeFileSync(
      join(
        hydraDir({ hydraId: 'lab' }),
        'heads-dispatch.json',
      ),
      JSON.stringify({
        rules: {
          'Bad Name!': {
            when: 'Old rule',
            candidates: [{ harness: 'claude' }],
          },
        },
      }),
    )
    assert.throws(
      () => effectiveDispatch(),
      (error: unknown) => {
        assert.ok(error instanceof HydraError)
        assert.match(
          error.message,
          /\/rules\/Bad Name! names use/,
        )
        assert.deepEqual(
          error.help,
          ['Run `pnyx-axi rule schema`, then fix it with `pnyx-axi rule apply`'],
        )

        return true
      },
    )
    assert.equal(
      show().document.rules['Bad Name!']?.when,
      'Old rule',
    )
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
                  'Bad Name!': null,
                  'Also Bad': {
                    when: 'Another',
                    candidates: [{ harness: 'claude' }],
                  },
                },
              },
            },
          }),
        ],
      }),
      paths: ['/rules/Also Bad'],
    })
    rule({
      args: [
        'apply',
        '--file',
        file({
          value: {
            version: 1,
            patch: { rules: { 'Bad Name!': null } },
          },
        }),
      ],
    })
    assert.deepEqual(
      effectiveDispatch().dispatch.rules,
      {},
    )
  },
)

test(
  'rule remove and rule accounts are patches through the same checks',
  () => {
    lab()
    assert.throws(
      () => rule({
        args: [
          'remove',
          'default',
        ],
      }),
      /default list cannot be removed/,
    )
    rule({
      args: [
        'remove',
        'build',
      ],
    })
    assert.equal(
      effectiveDispatch().dispatch.rules.build,
      undefined,
    )
    failsWith({
      run: () => rule({
        args: [
          'accounts',
          '--provider',
          'claude',
          '--order',
          'codex:test',
        ],
      }),
      paths: ['/workers/claude/0'],
    })
    failsWith({
      run: () => rule({
        args: [
          'accounts',
          '--provider',
          'codex',
          '--order',
          'codex:test',
          '--project',
          'relative',
        ],
      }),
      paths: ['/projects/relative'],
    })
    rule({
      args: [
        'accounts',
        '--main',
        'codex:test',
      ],
    })
    assert.equal(
      effectiveDispatch().dispatch.main,
      'codex:test',
    )
  },
)

test(
  'the CLI prints every problem of a refused patch read from stdin with its path, and exits 2',
  () => {
    lab()
    const result = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        'src/cli/pnyx-axi.ts',
        'rule',
        'apply',
        '--file',
        '-',
        '--hydra',
        'lab',
      ],
      {
        env: process.env,
        input: JSON.stringify({
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
        }),
        encoding: 'utf8',
      },
    )
    assert.equal(
      result.status,
      2,
    )
    assert.match(
      result.stdout,
      /errors\[2\]\{operation,path,code,reason\}:\n {2}null,"\/rules\/build\/candidates\/0\/effort",[^\n]+\n {2}null,"\/main",/,
    )
  },
)
