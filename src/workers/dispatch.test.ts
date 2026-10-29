import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import { configPath, effectiveDispatch, type EffectiveDispatch } from './dispatch-config.ts'
import { hydraDir } from '#app/home-migration.ts'
import { withWriter } from '#app/writer.ts'
import { base } from '#app/command-meta.ts'
import { accountEnvironment, chooseCandidate, chosenSettings, hostedOverride, overrideOf, validateChoice, type QuotaReading } from './dispatch.ts'
import { dispatchCommands } from './dispatch-cli.ts'
import { commands } from '#app/cli.ts'

// Keeps the default-login fallback away from the real harness logins.
const noLogin = join(
  mkdtempSync(join(
    tmpdir(),
    'pnyx-no-login-',
  )),
  'missing',
)
process.env.CLAUDE_CONFIG_DIR = join(
  noLogin,
  'claude',
)
process.env.CODEX_HOME = join(
  noLogin,
  'codex',
)

function writeShared({
  value,
  accounts = false,
}: {
  value: unknown
  accounts?: boolean
}): void {
  mkdirSync(
    dirname(configPath({ accounts })),
    { recursive: true },
  )
  writeFileSync(
    configPath({ accounts }),
    JSON.stringify(value),
  )
}

function setLogin({
  name,
  value,
}: {
  name: string
  value?: string
}): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function config(): EffectiveDispatch {
  return {
    dispatch: {
      main: 'claude:main',
      workers: {
        claude: [
          'claude:work',
          'claude:main',
        ],
        codex: ['codex:work'],
      },
      projects: {},
      rules: {
        build: {
          when: 'Implementation',
          candidates: [
            {
              harness: 'claude',
              model: 'opus',
            },
            {
              harness: 'codex',
              model: 'gpt-6.1-sol',
              effort: 'high',
            },
          ],
        },
      },
      default: [
        {
          harness: 'claude',
          model: 'haiku',
        },
      ],
    },
    accounts: {
      'claude:main': {
        provider: 'claude',
        folder: '/fake/main',
      },
      'claude:work': {
        provider: 'claude',
        folder: '/fake/work',
      },
      'codex:work': {
        provider: 'codex',
        folder: '/fake/codex',
      },
    },
  }
}

function reading({
  remaining,
  priority,
  exhausted = false,
  stale = false,
}: {
  remaining?: number
  priority?: number
  exhausted?: boolean
  stale?: boolean
}): QuotaReading {
  const effective = {
    status: remaining === undefined ? 'unknown' : 'known',
    effectivePercentRemaining: remaining,
    runway: { status: exhausted ? 'exhausted_now' : 'unknown' },
    selection: {
      status: priority === undefined ? 'unknown' : 'known',
      spendPriority: priority,
    },
  }

  return {
    auth: 'usable',
    effective,
    models: [
      {
        provider: 'claude',
        id: 'claude-opus-5-5',
        effective,
        state: { stale },
      },
      {
        provider: 'codex',
        id: 'gpt-6.1-sol',
        effective,
        state: { stale },
      },
    ],
  }
}

function lab() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-dispatch-',
  ))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  commands.hydra([
    'create',
    'lab',
  ])

  return {
    root,
    state: emptyHydra(),
  }
}

test(
  'each Hydra’s own dispatch, accounts and old agents merge into the shared files once, newest last, and the shared Hydra pin wins',
  () => {
    const { root } = lab()
    commands.hydra([
      'create',
      'other',
    ])
    commands.hydra([
      'create',
      'old',
    ])
    const shared = {
      main: 'claude:shared',
      rules: {
        hydra: {
          when: 'Hydra',
          candidates: [
            {
              harness: 'claude',
              model: 'claude-opus-5-5',
            },
          ],
        },
      },
    }
    const sharedAccounts = {
      accounts: {
        'claude:shared': {
          provider: 'claude',
          folder: root,
        },
      },
    }
    writeShared({ value: shared })
    writeShared({
      accounts: true,
      value: sharedAccounts,
    })

    const own = ({
      hydraId,
      file,
      value,
    }: {
      hydraId: string
      file: string
      value: unknown
    }) => {
      const path = join(
        hydraDir({ hydraId }),
        file,
      )
      writeFileSync(
        path,
        JSON.stringify(value),
      )

      return path
    }

    const older = new Date(Date.now() - 60_000)

    for (const path of [
      own({
        hydraId: 'lab',
        file: 'heads-dispatch.json',
        value: {
          rules: {
            docs: {
              when: 'Documentation',
              candidates: [{ harness: 'codex' }],
            },
            hydra: {
              when: 'Hydra',
              candidates: [{ harness: 'codex' }],
            },
          },
          workers: { codex: ['codex:lab'] },
          main: '',
        },
      }),
      own({
        hydraId: 'lab',
        file: 'accounts.json',
        value: {
          accounts: {
            'codex:lab': {
              provider: 'codex',
              folder: root,
            },
          },
        },
      }),
    ]) {
      utimesSync(
        path,
        older,
        older,
      )
    }

    const newest = own({
      hydraId: 'other',
      file: 'heads-dispatch.json',
      value: {
        rules: {
          docs: {
            when: 'Docs, as the newest Hydra set them',
            candidates: [{ harness: 'claude' }],
          },
        },
        default: [{ harness: 'codex' }],
      },
    })
    withWriter({
      hydraId: 'old',
      fn: ({ writer }) => {
        writer.append({
          event: {
            ...base({
              state: writer.state,
              meta: {
                at: older.toISOString(),
                actor: 'cli',
              },
              cardId: '$board',
            }),
            type: 'board.agents',
            data: {
              agents: {
                review: {
                  harness: 'claude',
                  model: 'claude-sonnet-5-5',
                  quota: 'high',
                },
              },
              before: {},
            },
          },
        })
      },
    })
    const {
      dispatch,
      accounts,
    } = effectiveDispatch()
    assert.deepEqual(
      dispatch.rules,
      {
        hydra: {
          when: 'Hydra',
          candidates: [
            {
              harness: 'claude',
              model: 'claude-opus-5-5',
            },
          ],
        },
        docs: {
          when: 'Docs, as the newest Hydra set them',
          candidates: [{ harness: 'claude' }],
        },
        review: {
          when: 'Use for review work',
          candidates: [
            {
              harness: 'claude',
              model: 'claude-sonnet-5-5',
            },
          ],
        },
      },
    )
    assert.deepEqual(
      dispatch.default,
      [{ harness: 'codex' }],
    )
    assert.equal(
      dispatch.main,
      'claude:shared',
    )
    assert.deepEqual(
      dispatch.workers,
      { codex: ['codex:lab'] },
    )
    assert.deepEqual(
      Object.keys(accounts).sort(),
      [
        'claude:shared',
        'codex:lab',
      ],
    )
    assert.ok(existsSync(`${newest}.merged`))
    assert.ok(!existsSync(newest))
    assert.ok(existsSync(join(
      hydraDir({ hydraId: 'lab' }),
      'accounts.json.merged',
    )))
    assert.deepEqual(
      JSON.parse(readFileSync(
        `${configPath()}.before-merge`,
        'utf8',
      )),
      shared,
    )
    assert.deepEqual(
      JSON.parse(readFileSync(
        `${configPath({ accounts: true })}.before-merge`,
        'utf8',
      )),
      sharedAccounts,
    )
    own({
      hydraId: 'other',
      file: 'heads-dispatch.json',
      value: { default: [{ harness: 'claude' }] },
    })
    assert.deepEqual(
      effectiveDispatch().dispatch.default,
      [{ harness: 'codex' }],
    )
  },
)

test(
  'candidate choice uses spendPriority rather than percent remaining or list order',
  () => {
    const current = config()
    const quota = ({ account }: { account: { provider: string } }) => account.provider === 'claude' ? reading({
      remaining: 25,
      priority: 12,
    }) : reading({
      remaining: 82,
      priority: 4,
    })
    const chosen = chooseCandidate({
      config: current,
      rule: 'build',
      quota,
    })
    assert.equal(
      chosen.account,
      'claude:work',
    )
    assert.match(
      chosen.reason,
      /25%.*82%/,
    )
    assert.match(
      chosen.reason,
      /spendPriority/,
    )
    current.dispatch.rules.build!.candidates.reverse()
    assert.deepEqual(
      chooseCandidate({
        config: current,
        rule: 'build',
        quota,
      }),
      chosen,
    )
  },
)

test(
  'dispatch balances by live quota, not rotation: unchanged readings keep one choice, a shifted overdraw flips it',
  () => {
    // Both accounts overdrawn against their reset clocks, Claude less so.
    const priorities: Record<string, number> = {
      claude: -0.2092,
      codex: -0.9649,
    }
    const quota = ({ account }: { account: { provider: string } }) => reading({
      remaining: account.provider === 'claude' ? 55 : 48,
      priority: priorities[account.provider],
    })
    const pick = () => chooseCandidate({
      config: config(),
      rule: 'build',
      quota,
    }).provider

    assert.deepEqual(
      [
        pick(),
        pick(),
        pick(),
      ],
      [
        'claude',
        'claude',
        'claude',
      ],
    )
    priorities.claude = -1.2
    assert.equal(
      pick(),
      'codex',
    )
  },
)

test(
  'on a spendPriority tie or with every quota unknown, the first listed candidate starts',
  () => {
    const current = config(), quota = () => reading({
      remaining: 50,
      priority: 0.4,
    })
    const tied = chooseCandidate({
      config: current,
      rule: 'build',
      quota,
    })
    assert.equal(
      tied.provider,
      'claude',
    )
    assert.match(
      tied.reason,
      /tie at spendPriority 0\.4; first listed candidate/,
    )
    current.dispatch.rules.build!.candidates.reverse()
    assert.equal(
      chooseCandidate({
        config: current,
        rule: 'build',
        quota,
      }).provider,
      'codex',
    )
    current.dispatch.rules.build!.candidates = [
      {
        harness: 'claude',
        model: 'sonnet',
      },
      {
        harness: 'claude',
        model: 'opus',
      },
    ]
    const unknown = chooseCandidate({
      config: current,
      rule: 'build',
      quota: () => ({ auth: 'unknown' }),
    })
    assert.equal(
      unknown.candidate.model,
      'sonnet',
    )
    assert.match(
      unknown.reason,
      /quota unknown; first listed candidate/,
    )
  },
)

test(
  'known quota outranks unknown quota, even overdrawn, as Firstmate ranks it',
  () => {
    const quota = ({ account }: { account: { provider: string } }) => account.provider === 'codex' ? reading({
      remaining: 91,
      priority: -0.64,
    }) : { auth: 'unknown' as const }
    const chosen = chooseCandidate({
      config: config(),
      rule: 'build',
      quota,
    })
    assert.equal(
      chosen.provider,
      'codex',
    )
    assert.match(
      chosen.reason,
      /claude:work\/opus: unknown/,
    )
    assert.match(
      chosen.reason,
      /codex:work\/gpt-6\.1-sol: 91%, spendPriority -0\.64/,
    )
    assert.match(
      chosen.reason,
      /unknown quota ranks below known/,
    )
  },
)

test(
  'the lowest spendPriority of the account and model windows bounds a candidate',
  () => {
    const current = config()
    current.dispatch.rules.build!.candidates = [
      {
        harness: 'claude',
        model: 'opus',
      },
    ]
    const account = reading({
      remaining: 80,
      priority: 0.3,
    })
    const quota = () => ({
      ...account,
      models: [
        {
          provider: 'claude',
          id: 'claude-opus-5-5',
          effective: {
            status: 'known',
            effectivePercentRemaining: 20,
            selection: {
              status: 'known',
              spendPriority: -0.2,
            },
          },
        },
      ],
    })
    assert.match(
      chooseCandidate({
        config: current,
        rule: 'build',
        quota,
      }).reason,
      /claude:work\/opus: 20%, spendPriority -0\.2/,
    )
  },
)

test(
  'spent accounts fall back in provider order, with per-project overrides',
  () => {
    const current = config(), visited: string[] = []

    const quota = ({ account }: { account: { folder: string } }) => {
      visited.push(account.folder)

      return reading({
        remaining: account.folder === '/fake/work' ? 0 : 25,
        priority: 4,
      })
    }

    current.dispatch.rules.build!.candidates = [
      {
        harness: 'claude',
        model: 'opus',
      },
    ]
    const chosen = chooseCandidate({
      config: current,
      rule: 'build',
      quota,
    })
    assert.equal(
      chosen.account,
      'claude:main',
    )
    assert.deepEqual(
      visited,
      [
        '/fake/work',
        '/fake/main',
      ],
    )
    current.dispatch.projects['/project'] = { claude: ['claude:main'] }
    visited.length = 0
    assert.equal(
      chooseCandidate({
        config: current,
        rule: 'build',
        project: '/project',
        quota,
      }).account,
      'claude:main',
    )
    assert.deepEqual(
      visited,
      ['/fake/main'],
    )
  },
)

test(
  'signed-out accounts stop rather than falling through; unlisted accounts are never read',
  () => {
    const visited: string[] = []
    assert.throws(
      () => chooseCandidate({
        config: config(),
        rule: 'build',
        quota: ({ account }) => {
          visited.push(account.folder)

          return { auth: 'signed-out' }
        },
      }),
      /claude:work is signed out/,
    )
    assert.deepEqual(
      visited,
      ['/fake/work'],
    )
    const current = config()
    current.dispatch.workers = { claude: [] }
    assert.throws(
      () => chooseCandidate({
        config: current,
        rule: 'build',
        quota: () => assert.fail('unlisted quota read'),
      }),
      /no usable candidates/,
    )
  },
)

test(
  'exhausted rules stop without using the default rule, including explicit runway exhaustion',
  () => {
    const readings = [
      () => reading({ remaining: 0 }),
      () => reading({
        remaining: 50,
        exhausted: true,
      }),
    ]

    for (const quota of readings) {
      assert.throws(
        () => chooseCandidate({
          config: config(),
          rule: 'build',
          quota,
        }),
        /rule build; start stopped/,
      )
    }

    assert.throws(
      () => chooseCandidate({
        config: config(),
        rule: 'missing',
        quota: () => assert.fail('quota read'),
      }),
      /no heads dispatch rule missing/,
    )
  },
)

test(
  'unknown and stale quotas are usable and recorded as unknown, and list order chooses between them',
  () => {
  // readQuota drops a stale account window, so only the stale model row is left.
    for (const quota of [
      () => ({ auth: 'unknown' as const }),
      () => ({
        ...reading({
          remaining: 0,
          stale: true,
        }),
        effective: undefined,
      }),
    ]) {
      const chosen = chooseCandidate({
        config: config(),
        rule: 'build',
        harness: 'claude',
        quota,
      })
      assert.match(
        chosen.reason,
        /unknown/,
      )
      assert.match(
        chosen.reason,
        /owner override/,
      )
      assert.doesNotMatch(
        chosen.reason,
        /0%/,
      )
      assert.equal(
        chooseCandidate({
          config: config(),
          rule: 'build',
          quota,
        }).candidate.model,
        'opus',
      )
    }
  },
)

test(
  'models unavailable through a harness are skipped without downgrading',
  () => {
    const quota = () => reading({ remaining: 50 })
    const chosen = chooseCandidate({
      config: config(),
      rule: 'build',
      quota,
      offers: {
        claude: [],
        codex: ['gpt-6.1-sol'],
      },
    })
    assert.equal(
      chosen.provider,
      'codex',
    )
    assert.match(
      chosen.reason,
      /not offered/,
    )
    assert.throws(
      () => chooseCandidate({
        config: config(),
        rule: 'build',
        quota,
        offers: {
          claude: [],
          codex: [],
        },
      }),
      /no usable candidates/,
    )
    // A catalog that was not read leaves that harness's model unchecked.
    assert.equal(
      chooseCandidate({
        config: config(),
        rule: 'build',
        harness: 'claude',
        quota,
        offers: { codex: [] },
      }).provider,
      'claude',
    )
  },
)

test(
  'settings-only overrides keep quota choosing the candidate; an explicit harness or model still wins',
  () => {
    // Claude's accounts are spent yet report a known priority, so only the spent veto keeps them below Codex's unknown quota.
    const quota = ({ account }: { account: { provider: string } }) => account.provider === 'claude'
      ? reading({
        remaining: 0,
        priority: -100,
        exhausted: true,
      })
      : reading({})

    for (const override of [
      { effort: 'low' },
      { mode: 'bypassPermissions' },
      { fast: true },
    ]) {
      const chosen = chooseCandidate({
        config: config(),
        rule: 'build',
        quota,
        override,
      })
      assert.deepEqual(
        [
          chosen.account,
          chosen.ownerOverride,
          chosen.override,
        ],
        [
          'codex:work',
          undefined,
          override,
        ],
      )
      assert.match(
        chosen.reason,
        /only usable candidate/,
      )
    }

    assert.deepEqual(
      chosenSettings({
        choice: chooseCandidate({
          config: config(),
          rule: 'build',
          quota,
          override: {
            effort: 'low',
            mode: 'never',
          },
        }),
      }),
      {
        model: 'gpt-6.1-sol',
        effort: 'low',
        mode: 'never',
      },
    )

    // An explicit harness or model is the owner's choice, so a spent account does not veto it.
    const harness = chooseCandidate({
      config: config(),
      rule: 'build',
      harness: 'claude',
      quota,
      override: { effort: 'low' },
    })
    const model = chooseCandidate({
      config: config(),
      rule: 'build',
      quota,
      override: {
        model: 'opus',
        mode: 'plan',
      },
      offers: {
        claude: ['opus'],
        codex: ['gpt-6.1-sol'],
      },
    })
    assert.deepEqual(
      [
        harness.account,
        harness.ownerOverride,
        chosenSettings({ choice: harness }),
        model.account,
        model.ownerOverride,
        chosenSettings({ choice: model }),
      ],
      [
        'claude:work',
        true,
        {
          model: 'opus',
          effort: 'low',
        },
        'claude:work',
        true,
        {
          model: 'opus',
          mode: 'plan',
        },
      ],
    )
  },
)

test(
  'a start override replaces the candidate settings, must be offered and is named in the choice',
  () => {
    const quota = () => reading({
      remaining: 50,
      priority: 0.2,
    })
    const current = config()
    current.dispatch.rules.build!.candidates = [
      {
        harness: 'claude',
        model: 'opus',
        effort: 'high',
        fast: true,
      },
    ]
    const chosen = chooseCandidate({
      config: current,
      rule: 'build',
      quota,
      override: {
        model: 'sonnet',
        effort: 'low',
        fast: false,
      },
      offers: {
        claude: [
          'opus',
          'sonnet',
        ],
      },
    })
    assert.deepEqual(
      chosen.candidate,
      current.dispatch.rules.build!.candidates[0],
    )
    assert.deepEqual(
      chosen.override,
      {
        model: 'sonnet',
        effort: 'low',
        fast: false,
      },
    )
    assert.match(
      chosen.reason,
      /build: sonnet on claude:work; .*override model sonnet, effort low, fast off/,
    )
    assert.deepEqual(
      chosenSettings({ choice: chosen }),
      {
        model: 'sonnet',
        effort: 'low',
        fast: 'false',
      },
    )
    assert.deepEqual(
      chosenSettings({
        choice: chooseCandidate({
          config: current,
          rule: 'build',
          quota,
        }),
      }),
      {
        model: 'opus',
        effort: 'high',
        fast: 'true',
      },
    )
    assert.throws(
      () => chooseCandidate({
        config: current,
        rule: 'build',
        quota,
        override: { model: 'gpt-6-luna' },
        offers: {
          claude: [
            'opus',
            'sonnet',
          ],
        },
      }),
      /gpt-6-luna: not offered/,
    )
    assert.equal(
      chooseCandidate({
        config: current,
        rule: 'build',
        quota,
        override: { model: 'opus[1m]' },
        offers: { claude: ['opus'] },
      }).override?.model,
      'opus[1m]',
    )
    assert.throws(
      () => chooseCandidate({
        config: current,
        rule: 'build',
        quota,
        override: { model: 'gpt-6-luna[1m]' },
        offers: { claude: ['opus'] },
      }),
      /not offered/,
    )
    assert.throws(
      () => hostedOverride({
        harness: 'codex',
        override: { effort: 'max' },
      }),
      /codex has no effort max/,
    )
    assert.throws(
      () => hostedOverride({
        harness: 'claude',
        override: { mode: 'never' },
      }),
      /claude has no mode never/,
    )
    assert.throws(
      () => overrideOf({ value: { harness: 'codex' } }),
      /may only set model, effort, mode and fast/,
    )
    assert.throws(
      () => overrideOf({ value: { fast: 'yes' } }),
      /fast must be true or false/,
    )
    assert.equal(
      overrideOf({ value: {} }),
      undefined,
    )
    const sent = chooseCandidate({
      config: config(),
      rule: 'build',
      harness: 'codex',
      quota,
      override: { effort: 'low' },
    })
    assert.deepEqual(
      validateChoice({
        value: JSON.parse(JSON.stringify(sent)),
        config: config(),
      }).override,
      { effort: 'low' },
    )
    assert.throws(
      () => validateChoice({
        value: {
          ...sent,
          override: { effort: 'max' },
        },
        config: config(),
      }),
      /codex has no effort max/,
    )
  },
)

test(
  'with no registered accounts, dispatch falls back to the harnesses’ own logins',
  () => {
    const { root } = lab()
    const claude = join(
      root,
      'claude',
    )
    mkdirSync(claude)
    process.env.CLAUDE_CONFIG_DIR = claude

    try {
      const effective = effectiveDispatch()
      assert.deepEqual(
        effective.accounts,
        {
          'claude:default': {
            provider: 'claude',
            folder: claude,
          },
        },
      )
      assert.equal(
        effective.dispatch.main,
        'claude:default',
      )
      assert.deepEqual(
        effective.dispatch.workers,
        { claude: ['claude:default'] },
      )
      const chosen = chooseCandidate({
        config: effective,
        quota: () => ({ auth: 'unknown' }),
      })
      assert.equal(
        chosen.account,
        'claude:default',
      )
      assert.equal(
        validateChoice({
          value: {
            ...chosen,
            folder: '/caller/login',
          },
          config: effective,
        }).folder,
        claude,
      )
      writeShared({
        value: { main: 'claude:work' },
      })
      assert.throws(
        () => chooseCandidate({
          config: effectiveDispatch(),
          quota: () => ({ auth: 'unknown' }),
        }),
        /registered main account/,
      )
      dispatchCommands.account([
        'set',
        'claude:work',
        '--provider',
        'claude',
        '--folder',
        claude,
        '--hydra',
        'lab',
      ])
      assert.deepEqual(
        Object.keys(effectiveDispatch().accounts),
        ['claude:work'],
      )
    } finally {
      process.env.CLAUDE_CONFIG_DIR = join(
        noLogin,
        'claude',
      )
    }

    const env = {
      PATH: '/fake',
      ANTHROPIC_API_KEY: 'kept',
    }
    const own = {
      provider: 'claude' as const,
      folder: '~/.claude',
    }
    assert.equal(
      accountEnvironment({
        account: own,
        env,
      }),
      env,
    )
    assert.equal(
      accountEnvironment({
        account: own,
        env: {
          ...env,
          CLAUDE_CONFIG_DIR: '/other',
        },
      }).CLAUDE_CONFIG_DIR,
      join(
        homedir(),
        '.claude',
      ),
    )
  },
)

test(
  'rule init takes login folders from CLAUDE_CONFIG_DIR and CODEX_HOME, keeps a file that exists and never replaces a saved document',
  () => {
    const accountsFile = () => JSON.parse(readFileSync(
      configPath({ accounts: true }),
      'utf8',
    )) as unknown
    const registry = ({
      claude,
      codex,
    }: {
      claude: string
      codex: string
    }) => ({
      accounts: {
        'claude:personal': {
          provider: 'claude',
          folder: claude,
        },
        'codex:personal': {
          provider: 'codex',
          folder: codex,
        },
      },
    })

    try {
      for (const [
        claude,
        codex,
        expected,
      ] of [
          [
            undefined,
            undefined,
            [
              '~/.claude',
              '~/.codex',
            ],
          ],
          [
            '',
            '',
            [
              '~/.claude',
              '~/.codex',
            ],
          ],
          [
            '/logins/claude',
            undefined,
            [
              '/logins/claude',
              '~/.codex',
            ],
          ],
          [
            '/logins/claude',
            '/logins/codex',
            [
              '/logins/claude',
              '/logins/codex',
            ],
          ],
        ] as const) {
        lab()
        setLogin({
          name: 'CLAUDE_CONFIG_DIR',
          value: claude,
        })
        setLogin({
          name: 'CODEX_HOME',
          value: codex,
        })
        dispatchCommands.rule([
          'init',
          '--hydra',
          'lab',
        ])
        assert.deepEqual(
          accountsFile(),
          registry({
            claude: expected[0],
            codex: expected[1],
          }),
        )
      }

      const dispatch = readFileSync(
        configPath(),
        'utf8',
      )
      process.env.CLAUDE_CONFIG_DIR = '/logins/other'
      dispatchCommands.rule([
        'init',
        '--hydra',
        'lab',
      ])
      assert.equal(
        readFileSync(
          configPath(),
          'utf8',
        ),
        dispatch,
      )
      assert.deepEqual(
        accountsFile(),
        registry({
          claude: '/logins/claude',
          codex: '/logins/codex',
        }),
      )
      lab()
      const mine = {
        accounts: {
          'claude:mine': {
            provider: 'claude',
            folder: '~/.claude-mine',
          },
        },
      }
      writeShared({
        accounts: true,
        value: mine,
      })
      dispatchCommands.rule([
        'init',
        '--hydra',
        'lab',
      ])
      assert.deepEqual(
        accountsFile(),
        mine,
      )
    } finally {
      process.env.CLAUDE_CONFIG_DIR = join(
        noLogin,
        'claude',
      )
      process.env.CODEX_HOME = join(
        noLogin,
        'codex',
      )
    }
  },
)

test(
  'hosted choice validation rejects unlisted accounts, changed rules and provider mismatches',
  () => {
    const current = config()
    current.dispatch.rules.build!.candidates = [
      {
        harness: 'claude',
        model: 'opus',
      },
    ]
    const chosen = chooseCandidate({
      config: current,
      rule: 'build',
      quota: () => reading({ remaining: 50 }),
    })
    assert.deepEqual(
      validateChoice({
        value: chosen,
        config: current,
      }),
      chosen,
    )
    assert.throws(
      () => validateChoice({
        value: {
          ...chosen,
          account: 'claude:main',
          folder: '/fake/main',
          provider: 'codex',
        },
        config: current,
      }),
      /choice is invalid/,
    )
    current.dispatch.workers.claude = ['claude:main']
    assert.throws(
      () => validateChoice({
        value: chosen,
        config: current,
      }),
      /choice is invalid/,
    )
    current.dispatch.workers.claude = ['claude:work']
    current.dispatch.rules.build!.candidates = [{ harness: 'codex' }]
    assert.throws(
      () => validateChoice({
        value: chosen,
        config: current,
      }),
      /choice is invalid/,
    )
  },
)

test(
  'a stale quota model catalog does not exclude a model the harness offers',
  () => {
    const current = config()
    const candidate = {
      harness: 'claude' as const,
      model: 'claude-opus-5-5',
    }
    current.dispatch.rules.build!.candidates = [candidate]
    const chosen = chooseCandidate({
      config: current,
      rule: 'build',
      quota: () => ({
        auth: 'usable',
        models: [
          {
            provider: 'claude',
            id: 'claude-opus-4-5',
          },
        ],
      }),
    })
    assert.deepEqual(
      chosen.candidate,
      candidate,
    )
    assert.match(
      chosen.reason,
      /unknown/,
    )
  },
)
