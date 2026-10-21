import { hydraEvent } from '../src/core/hydra.ts'
import { withWriter } from '../src/store/hydra-store.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra } from '../src/core/reducer.ts'
import { configPath, effectiveDispatch, parseAccounts, parseDispatch, writeConfig, type EffectiveDispatch } from '../src/dispatch/config.ts'
import { accountEnvironment, chooseCandidate, chosenSettings, hostedOverride, overrideOf, readQuota, validateChoice, type QuotaReading } from '../src/dispatch/select.ts'
import { dispatchCommands, STARTER_ACCOUNTS, STARTER_DISPATCH } from '../src/dispatch/cli.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { commands } from '../src/cli/commands.ts'

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
  'sections inherit shared config; nonempty local sections replace whole sections',
  () => {
    const {
      root,
      state,
    } = lab()
    fakeDispatch({ root })
    writeConfig({
      path: configPath({
        hydraId: 'lab',
        shared: true,
      }),
      value: STARTER_DISPATCH,
    })
    writeConfig({
      path: configPath({ hydraId: 'lab' }),
      value: {
        rules: {},
        default: [],
        workers: {},
        projects: {},
        main: '',
      },
    })
    let effective = effectiveDispatch({
      hydraId: 'lab',
      state,
    })
    assert.deepEqual(
      effective.dispatch,
      STARTER_DISPATCH,
    )
    writeConfig({
      path: configPath({ hydraId: 'lab' }),
      value: {
        rules: {
          docs: {
            when: 'Documentation',
            candidates: [{ harness: 'codex' }],
          },
        },
        workers: { codex: ['codex:test'] },
      },
    })
    effective = effectiveDispatch({
      hydraId: 'lab',
      state,
    })
    assert.deepEqual(
      Object.keys(effective.dispatch.rules),
      ['docs'],
    )
    assert.deepEqual(
      effective.dispatch.default,
      STARTER_DISPATCH.default,
    )
    assert.deepEqual(
      effective.dispatch.workers,
      { codex: ['codex:test'] },
    )
    writeConfig({
      path: configPath({
        hydraId: 'lab',
        accounts: true,
      }),
      accounts: true,
      value: { accounts: {} },
    })
    assert.equal(
      Object.keys(effectiveDispatch({
        hydraId: 'lab',
        state,
      }).accounts).length,
      2,
    )
    writeConfig({
      path: configPath({
        hydraId: 'lab',
        accounts: true,
      }),
      accounts: true,
      value: {
        accounts: {
          only: {
            provider: 'codex',
            folder: root,
          },
        },
      },
    })
    assert.deepEqual(
      Object.keys(effectiveDispatch({
        hydraId: 'lab',
        state,
      }).accounts),
      ['only'],
    )
  },
)

test(
  'old agent data loads as rules and migrates without changing its event log',
  () => {
    const { state } = lab()
    state.config = {
      id: 'lab',
      name: 'lab',
      hydra: {
        id: 'hydra',
        name: 'Hydra',
        kind: 'agent',
      },
      columns: [],
      agents: {
        review: {
          harness: 'codex',
          model: 'gpt-6.1-sol',
          quota: 'high',
        },
        default: {
          harness: 'claude',
          model: 'opus',
        },
      },
    }
    const effective = effectiveDispatch({
      hydraId: 'lab',
      state,
    })
    assert.deepEqual(
      effective.dispatch.rules.review?.candidates,
      [
        {
          harness: 'codex',
          model: 'gpt-6.1-sol',
        },
      ],
    )
    assert.deepEqual(
      effective.dispatch.default,
      [
        {
          harness: 'claude',
          model: 'opus',
        },
      ],
    )
    assert.equal(
      state.config.agents?.review?.quota,
      'high',
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
  'a genuine spendPriority tie stops the start and names every tied candidate',
  () => {
    const current = config(), quota = () => reading({
      remaining: 50,
      priority: 0.4,
    })
    assert.throws(
      () => chooseCandidate({
        config: current,
        rule: 'build',
        quota,
      }),
      (error: Error & { code?: string }) =>
        error.code === 'DISPATCH_TIE' && /claude\/opus on claude:work, codex\/gpt-6\.1-sol on codex:work tie at spendPriority 0\.4/.test(error.message),
    )
    assert.throws(
      () => chooseCandidate({
        config: current,
        rule: 'build',
        quota,
      }),
      (error: Error & { help?: string[] }) => /Pick one with --harness claude\|codex/.test(error.help?.[0] ?? ''),
    )
    assert.equal(
      chooseCandidate({
        config: current,
        rule: 'build',
        harness: 'codex',
        quota,
      }).provider,
      'codex',
    )
    current.dispatch.rules.build!.candidates = [
      {
        harness: 'claude',
        model: 'opus',
      },
      {
        harness: 'claude',
        model: 'sonnet',
      },
    ]
    assert.throws(
      () => chooseCandidate({
        config: current,
        rule: 'build',
        quota: () => ({ auth: 'unknown' }),
      }),
      (error: Error & { help?: string[] }) =>
        /all have unknown quota/.test(error.message) && /split rule build/.test(error.help?.[0] ?? ''),
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
  'unknown and stale quotas are usable and recorded as unknown, but never chosen between',
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
      assert.throws(
        () => chooseCandidate({
          config: config(),
          rule: 'build',
          quota,
        }),
        /no single best candidate.*all have unknown quota/,
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
  'account folders isolate quota-axi and hosted environments from inherited credentials',
  () => {
    const { root } = lab()
    const {
      claude,
      codex,
    } = fakeDispatch({ root })
    writeFileSync(
      join(
        claude,
        'quota.json',
      ),
      JSON.stringify({
        provider: {
          state: {
            status: 'auth_required',
            authStatus: 'unusable',
          },
        },
      }),
    )
    assert.equal(
      readQuota({
        account: {
          provider: 'claude',
          folder: claude,
        },
      }).auth,
      'signed-out',
    )
    assert.equal(
      readQuota({
        account: {
          provider: 'codex',
          folder: codex,
        },
      }).auth,
      'usable',
    )
    const env = accountEnvironment({
      account: {
        provider: 'codex',
        folder: codex,
      },
      env: {
        PATH: '/fake',
        OPENAI_API_KEY: 'discard',
        ANTHROPIC_API_KEY: 'discard',
        CLAUDE_CODE_OAUTH_TOKEN: 'discard',
        CLAUDE_CONFIG_DIR: '/wrong',
        CODEX_HOME: '/wrong',
      },
    })
    assert.deepEqual(
      env,
      {
        PATH: '/fake',
        CODEX_HOME: codex,
      },
    )
  },
)

test(
  'quota-axi reads a default login as the harness does, and models without --profile-only',
  () => {
    const { root } = lab()
    const { claude } = fakeDispatch({ root })
    const window = {
      scope: 'all_models',
      status: 'known',
      effectivePercentRemaining: 80,
      selection: {
        status: 'known',
        spendPriority: 0.3,
      },
    }
    const quota = JSON.stringify({
      provider: { quotaSemantics: { effectiveAvailability: [window] } },
      models: [
        {
          provider: 'claude',
          id: 'claude-opus-5-5',
          effective: window,
        },
      ],
    })
    const saved = {
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    }
    writeFileSync(
      join(
        claude,
        'quota.json',
      ),
      quota,
    )
    assert.equal(
      readQuota({
        account: {
          provider: 'claude',
          folder: claude,
        },
      }).effective?.selection?.spendPriority,
      0.3,
    )
    assert.equal(
      readQuota({
        account: {
          provider: 'claude',
          folder: claude,
        },
      }).models?.length,
      1,
    )

    try {
      process.env.HOME = join(
        root,
        'home',
      )
      delete process.env.CLAUDE_CONFIG_DIR
      mkdirSync(
        join(
          root,
          'home',
          '.claude',
        ),
        { recursive: true },
      )
      writeFileSync(
        join(
          root,
          'home',
          '.claude',
          'quota.json',
        ),
        quota,
      )
      const reading = readQuota({
        account: {
          provider: 'claude',
          folder: join(
            root,
            'home',
            '.claude',
          ),
        },
      })
      assert.equal(
        reading.effective?.effectivePercentRemaining,
        80,
      )
      assert.equal(
        reading.models?.[0]?.id,
        'claude-opus-5-5',
      )
    } finally {
      process.env.HOME = saved.HOME
      process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR
    }
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
      /fast must be boolean/,
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
  'CLI initializes starter files, edits rules and accounts, and rejects secret fields',
  () => {
    const { root } = lab()
    dispatchCommands.rule([
      'init',
      '--shared',
      '--hydra',
      'lab',
    ])
    const global = configPath({
      hydraId: 'lab',
      shared: true,
    })
    assert.deepEqual(
      JSON.parse(readFileSync(
        global,
        'utf8',
      )),
      STARTER_DISPATCH,
    )
    assert.deepEqual(
      JSON.parse(readFileSync(
        configPath({
          hydraId: 'lab',
          shared: true,
          accounts: true,
        }),
        'utf8',
      )),
      STARTER_ACCOUNTS,
    )
    dispatchCommands.rule([
      'set',
      'docs',
      '--when',
      'Writing docs',
      '--candidates',
      '[{"harness":"codex","model":"gpt-6-luna"}]',
      '--hydra',
      'lab',
    ])
    dispatchCommands.rule([
      'accounts',
      '--main',
      'codex:personal',
      '--provider',
      'codex',
      '--order',
      'codex:work,codex:personal',
      '--project',
      root,
      '--hydra',
      'lab',
    ])
    const effective = dispatchCommands.rule([
      'list',
      '--hydra',
      'lab',
    ]) as unknown as EffectiveDispatch
    assert.equal(
      effective.dispatch.rules.docs?.when,
      'Writing docs',
    )
    assert.equal(
      effective.dispatch.main,
      'codex:personal',
    )
    assert.deepEqual(
      effective.dispatch.projects[root]?.codex,
      [
        'codex:work',
        'codex:personal',
      ],
    )
    dispatchCommands.account([
      'set',
      'codex:lab',
      '--provider',
      'codex',
      '--folder',
      root,
      '--hydra',
      'lab',
    ])
    assert.equal(
      effectiveDispatch({
        hydraId: 'lab',
        state: emptyHydra(),
      }).accounts['codex:lab']?.folder,
      root,
    )
    assert.throws(
      () => parseAccounts({
        value: {
          accounts: {
            test: {
              provider: 'claude',
              folder: root,
              token: 'secret',
            },
          },
        },
      }),
      /unknown fields token/,
    )
    assert.throws(
      () => parseDispatch({
        value: {
          rules: {
            bad: {
              when: '',
              candidates: [],
            },
          },
        },
      }),
      /plain-language when/,
    )
    mkdirSync(
      join(
        root,
        'pnyx',
        'hydras',
        'bad',
      ),
      { recursive: true },
    )
    writeFileSync(
      configPath({ hydraId: 'bad' }),
      '{',
    )
    assert.throws(
      () => effectiveDispatch({
        hydraId: 'bad',
        state: emptyHydra(),
      }),
      /invalid JSON/,
    )
  },
)

test(
  'with no registered accounts, dispatch falls back to the harnesses’ own logins',
  () => {
    const {
      root,
      state,
    } = lab()
    const claude = join(
      root,
      'claude',
    )
    mkdirSync(claude)
    process.env.CLAUDE_CONFIG_DIR = claude

    try {
      const effective = effectiveDispatch({
        hydraId: 'lab',
        state,
      })
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
      writeConfig({
        path: configPath({
          hydraId: 'lab',
          shared: true,
        }),
        value: { main: 'claude:work' },
      })
      assert.throws(
        () => chooseCandidate({
          config: effectiveDispatch({
            hydraId: 'lab',
            state,
          }),
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
        Object.keys(effectiveDispatch({
          hydraId: 'lab',
          state,
        }).accounts),
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
  'shipped starter templates match the initializer',
  () => {
    assert.deepEqual(
      JSON.parse(readFileSync(
        new URL(
          '../setup/config/hydra-heads-dispatch.json',
          import.meta.url,
        ),
        'utf8',
      )),
      STARTER_DISPATCH,
    )
    assert.deepEqual(
      JSON.parse(readFileSync(
        new URL(
          '../setup/config/hydra-accounts.json',
          import.meta.url,
        ),
        'utf8',
      )),
      STARTER_ACCOUNTS,
    )
  },
)

test(
  'migration writes local rules once and later edits preserve the migrated default',
  () => {
    lab()
    withWriter({
      hydraId: 'lab',
      create: true,
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            at: '2026-10-16T00:00:00Z',
            actor: 'test',
          },
          cardId: '$board',
          change: {
            type: 'board.agents',
            data: {
              before: {},
              agents: {
                default: {
                  harness: 'codex',
                  model: 'gpt-6.1-sol',
                },
                review: {
                  harness: 'claude',
                  model: 'opus',
                },
              },
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const log = join(
      process.env.PNYX_HOME!,
      'hydras',
      'lab',
      'events.jsonl',
    )
    const before = readFileSync(
      log,
      'utf8',
    )
    dispatchCommands.rule([
      'migrate',
      '--hydra',
      'lab',
    ])
    const migrated = JSON.parse(readFileSync(
      configPath({ hydraId: 'lab' }),
      'utf8',
    ))
    assert.deepEqual(
      migrated.default,
      [
        {
          harness: 'codex',
          model: 'gpt-6.1-sol',
        },
      ],
    )
    assert.equal(
      migrated.rules.review.when,
      'Use for review work',
    )
    assert.match(
      String(dispatchCommands.rule([
        'migrate',
        '--hydra',
        'lab',
      ]).event),
      /already exists/,
    )
    dispatchCommands.rule([
      'set',
      'docs',
      '--harness',
      'claude',
      '--model',
      'haiku',
      '--hydra',
      'lab',
    ])
    const edited = JSON.parse(readFileSync(
      configPath({ hydraId: 'lab' }),
      'utf8',
    ))
    assert.deepEqual(
      edited.default,
      migrated.default,
    )
    assert.equal(
      readFileSync(
        log,
        'utf8',
      ),
      before,
    )
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
  'AXI edits materialize inherited sections without dropping sibling settings',
  () => {
    const { root } = lab()
    fakeDispatch({ root })
    writeConfig({
      path: configPath({ hydraId: 'lab' }),
      value: {
        rules: {},
        workers: {},
        projects: {},
      },
    })
    dispatchCommands.rule([
      'accounts',
      '--provider',
      'claude',
      '--order',
      'claude:test',
      '--hydra',
      'lab',
    ])
    const effective = effectiveDispatch({
      hydraId: 'lab',
      state: emptyHydra(),
    })
    assert.deepEqual(
      effective.dispatch.workers.codex,
      ['codex:test'],
    )
    dispatchCommands.account([
      'set',
      'codex:extra',
      '--provider',
      'codex',
      '--folder',
      root,
      '--hydra',
      'lab',
    ])
    assert.deepEqual(
      Object.keys(effectiveDispatch({
        hydraId: 'lab',
        state: emptyHydra(),
      }).accounts).sort(),
      [
        'claude:test',
        'codex:extra',
        'codex:test',
      ],
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
