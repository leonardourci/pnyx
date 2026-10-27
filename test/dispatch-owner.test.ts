import { project } from '../src/projects/cli.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { approval } from '../src/confirmations/commands.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { ownerOnly } from '../src/cli/hydra-session.ts'
import { emptyHydra } from '../src/core/reducer.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { configPath, effectiveDispatch, writeConfig } from '../src/dispatch/config.ts'
import { chooseCandidate, chosenSettings, validateChoice } from '../src/dispatch/select.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { hydraDir } from '../src/app/home-migration.ts'
import { fakeDispatch } from '../src/test-harness/dispatch-fixture.ts'

function lab() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-owner-dispatch-',
  ))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  process.env.PNYX_SEMANTIC = 'off'
  const fixture = fakeDispatch({ root })
  commands.hydra([
    'create',
    'lab',
  ])

  return {
    root,
    fixture,
  }
}

test(
  'fallback and template rules rank both providers through quota-axi',
  () => {
    const { fixture } = lab()
    writeConfig({
      path: configPath({
        hydraId: 'lab',
        shared: true,
      }),
      value: {
        main: 'claude:test',
        workers: {
          claude: ['claude:test'],
          codex: ['codex:test'],
        },
      },
    })
    const config = effectiveDispatch({
      hydraId: 'lab',
      state: emptyHydra(),
    })

    for (const rule of [
      config.dispatch.default,
      ...Object.values(config.dispatch.rules).map(r => r.candidates),
    ]) {
      assert.deepEqual(
        new Set(rule.map(c => c.harness)),
        new Set([
          'claude',
          'codex',
        ]),
      )
    }

    for (const [
      folder,
      priority,
    ] of [
        [
          fixture.claude,
          0.2,
        ],
        [
          fixture.codex,
          0.8,
        ],
      ] as const) {
      writeFileSync(
        join(
          folder,
          'quota.json',
        ),
        JSON.stringify({
          provider: {
            quotaSemantics: {
              effectiveAvailability: [
                {
                  scope: 'all_models',
                  status: 'known',
                  effectivePercentRemaining: 50,
                  selection: {
                    status: 'known',
                    spendPriority: priority,
                  },
                },
              ],
            },
          },
        }),
      )
    }

    const chosen = chooseCandidate({ config })
    assert.equal(
      chosen.provider,
      'codex',
    )
    assert.match(
      chosen.reason,
      /claude:test.*spendPriority 0.2.*codex:test.*spendPriority 0.8/,
    )
  },
)

test(
  'owner harness or model wins outside a Claude-only rule and ignores quota vetoes',
  () => {
    lab()
    const config = effectiveDispatch({
      hydraId: 'lab',
      state: emptyHydra(),
    })
    config.dispatch.default = [
      {
        harness: 'claude',
        model: 'claude-sonnet-5-5',
      },
    ]
    config.dispatch.workers.codex = []
    delete config.dispatch.main
    const chosen = chooseCandidate({
      config,
      rule: 'missing',
      harness: 'codex',
      override: {
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
        mode: 'never',
        fast: true,
      },
      offers: { codex: ['gpt-6.1-sol'] },
      quota: () => ({
        auth: 'usable',
        effective: {
          status: 'known',
          effectivePercentRemaining: 0,
          runway: { status: 'exhausted_now' },
        },
      }),
    })
    assert.equal(
      chosen.provider,
      'codex',
    )
    assert.equal(
      chosen.ownerOverride,
      true,
    )
    assert.match(
      chosen.reason,
      /owner override/,
    )
    assert.deepEqual(
      chosenSettings({ choice: chosen }),
      {
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
        mode: 'never',
        fast: 'true',
      },
    )
    assert.deepEqual(
      validateChoice({
        config,
        value: chosen,
      }),
      chosen,
    )
    assert.equal(
      chooseCandidate({
        config,
        override: { model: 'gpt-6.1-sol' },
        offers: {
          claude: ['sonnet'],
          codex: ['gpt-6.1-sol'],
        },
        quota: () => ({ auth: 'unknown' }),
      }).provider,
      'codex',
    )
    assert.throws(
      () => chooseCandidate({
        config,
        harness: 'codex',
        override: { model: 'unsupported' },
        offers: { codex: ['gpt-6.1-sol'] },
        quota: () => assert.fail('unsupported model read login'),
      }),
      /no usable candidates/,
    )
    assert.throws(
      () => chooseCandidate({
        config,
        harness: 'codex',
        quota: () => ({ auth: 'signed-out' }),
      }),
      /signed out/,
    )
  },
)

test(
  'Hydra proposals survive replay and only owner confirmation applies them',
  () => {
    lab()
    const hydra = ownerOnly({
      commands: dispatchCommands,
      env: { PNYX_ACTOR: 'hydra' },
    })
    const path = configPath({ hydraId: 'lab' })
    const before = effectiveDispatch({
      hydraId: 'lab',
      state: loadHydra({ hydraId: 'lab' }).state,
    })
    const result = hydra.rule([
      'propose',
      'set',
      'default',
      '--harness',
      'codex',
      '--model',
      'gpt-6.1-sol',
      '--actor',
      'hydra',
      '--hydra',
      'lab',
    ]) as { token: string }
    assert.ok(result.token)
    assert.deepEqual(
      effectiveDispatch({
        hydraId: 'lab',
        state: loadHydra({ hydraId: 'lab' }).state,
      }),
      before,
    )
    rmSync(
      join(
        hydraDir({ hydraId: 'lab' }),
        'snapshot.json',
      ),
      { force: true },
    )
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.dispatchProposals?.[0]?.token,
      result.token,
    )
    assert.throws(
      () => hydra.rule([
        'confirm',
        result.token,
        '--confirm',
        result.token,
        '--hydra',
        'lab',
      ]),
      /Only the owner/,
    )
    assert.throws(
      () => dispatchCommands.rule([
        'confirm',
        result.token,
        '--confirm',
        result.token,
        '--actor',
        'hydra',
        '--hydra',
        'lab',
      ]),
      /Only the owner/,
    )
    assert.equal(
      (dispatchCommands.rule([
        'confirm',
        result.token,
        '--hydra',
        'lab',
      ]) as { confirmation: string }).confirmation,
      'needed',
    )
    dispatchCommands.rule([
      'confirm',
      result.token,
      '--confirm',
      result.token,
      '--hydra',
      'lab',
    ])
    assert.equal(
      JSON.parse(readFileSync(
        path,
        'utf8',
      )).default[0].harness,
      'codex',
    )
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.dispatchProposals?.length,
      0,
    )
    assert.match(
      String(dispatchCommands.rule([
        'confirm',
        result.token,
        '--confirm',
        result.token,
        '--hydra',
        'lab',
      ]).event),
      /already resolved/,
    )
  },
)

test(
  'Dismiss and stale confirmation preserve configuration, including account proposals',
  () => {
    const { root } = lab()
    const args = [
      'propose',
      'set',
      'codex:new',
      '--provider',
      'codex',
      '--folder',
      root,
      '--actor',
      'hydra',
      '--shared',
      '--hydra',
      'lab',
    ]
    const proposal = dispatchCommands.account(args) as { token: string }
    assert.equal(
      effectiveDispatch({
        hydraId: 'lab',
        state: emptyHydra(),
      }).accounts['codex:new'],
      undefined,
    )
    dispatchCommands.rule([
      'dismiss',
      proposal.token,
      '--hydra',
      'lab',
    ])
    assert.equal(
      effectiveDispatch({
        hydraId: 'lab',
        state: emptyHydra(),
      }).accounts['codex:new'],
      undefined,
    )
    const next = dispatchCommands.account(args) as { token: string }
    writeConfig({
      path: configPath({ hydraId: 'lab' }),
      value: { default: [{ harness: 'codex' }] },
    })
    assert.throws(
      () => dispatchCommands.rule([
        'confirm',
        next.token,
        '--confirm',
        next.token,
        '--hydra',
        'lab',
      ]),
      /configuration changed/,
    )
    assert.equal(
      effectiveDispatch({
        hydraId: 'lab',
        state: emptyHydra(),
      }).accounts['codex:new'],
      undefined,
    )
    dispatchCommands.rule([
      'dismiss',
      next.token,
      '--hydra',
      'lab',
    ])
    const final = dispatchCommands.account(args) as { token: string }
    dispatchCommands.rule([
      'confirm',
      final.token,
      '--confirm',
      final.token,
      '--hydra',
      'lab',
    ])
    assert.equal(
      effectiveDispatch({
        hydraId: 'lab',
        state: emptyHydra(),
      }).accounts['codex:new']?.folder,
      root,
    )
  },
)

test(
  'owner-only actions become questions, and Confirm executes the exact command once',
  async () => {
    lab()
    const hydra = ownerOnly({
      commands,
      env: { PNYX_ACTOR: 'hydra' },
    })
    const request = hydra.hydra([
      'set',
      '--command',
      'printf approved',
      '--hydra',
      'lab',
    ]) as { token: string }
    assert.ok(request.token)
    commands.task([
      'create',
      '--title',
      'Unrelated work',
      '--hydra',
      'lab',
    ])
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.config?.command,
      undefined,
    )
    await assert.rejects(
      approval([
        'confirm',
        request.token,
        '--confirm',
        request.token,
        '--actor',
        'hydra',
        '--hydra',
        'lab',
      ]),
      /Only the owner/,
    )
    await approval([
      'confirm',
      request.token,
      '--confirm',
      request.token,
      '--hydra',
      'lab',
    ])
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.config?.command,
      'printf approved',
    )
    const count = loadHydra({ hydraId: 'lab' }).state.seq
    await approval([
      'confirm',
      request.token,
      '--confirm',
      request.token,
      '--hydra',
      'lab',
    ])
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.seq,
      count,
    )
    const dismissed = hydra.hydra([
      'set',
      '--command',
      'printf dismissed',
      '--hydra',
      'lab',
    ]) as { token: string }
    await approval([
      'dismiss',
      dismissed.token,
      '--hydra',
      'lab',
    ])
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.config?.command,
      'printf approved',
    )
  },
)

test(
  'approval failure stays visible, blocks replay and permits dismissal',
  async () => {
    lab()
    const hydra = ownerOnly({
      commands,
      env: { PNYX_ACTOR: 'hydra' },
    })
    const request = hydra.hydra([
      'set',
      '--command',
      'printf invalid',
      '--unknown-option',
      '--hydra',
      'lab',
    ]) as { token: string }
    await assert.rejects(approval([
      'confirm',
      request.token,
      '--confirm',
      request.token,
      '--hydra',
      'lab',
    ]))
    const failed = loadHydra({ hydraId: 'lab' }).state.dispatchProposals?.find(p => p.token === request.token)
    assert.equal(
      failed?.status,
      'failed',
    )
    assert.ok(failed?.error)
    await assert.rejects(
      approval([
        'confirm',
        request.token,
        '--confirm',
        request.token,
        '--hydra',
        'lab',
      ]),
      /failed action/,
    )
    await approval([
      'dismiss',
      request.token,
      '--hydra',
      'lab',
    ])
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.dispatchProposals?.length,
      0,
    )
  },
)

test(
  'leading flags and propose subcommands cannot let Hydra confirm its own change',
  () => {
    lab()
    const hydra = ownerOnly({
      commands: {
        ...commands,
        ...dispatchCommands,
      },
      env: { PNYX_ACTOR: 'hydra' },
    })
    const request = hydra.rule([
      'propose',
      'set',
      'default',
      '--harness',
      'codex',
      '--actor',
      'hydra',
      '--hydra',
      'lab',
    ]) as { token: string }
    assert.throws(
      () => hydra.rule([
        'propose',
        'confirm',
        request.token,
        '--confirm',
        request.token,
        '--actor',
        'web',
        '--hydra',
        'lab',
      ]),
      /propose set/,
    )
    assert.throws(
      () => hydra.rule([
        '--hydra',
        'lab',
        'confirm',
        request.token,
        '--confirm',
        request.token,
        '--actor',
        'web',
      ]),
      /Only the owner/,
    )
    const leading = hydra.task([
      '--hydra',
      'lab',
      'copy',
      'missing-task',
      'remove',
      '--discard',
    ]) as { token: string }
    assert.ok(leading.token)
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.dispatchProposals?.length,
      2,
    )
  },
)

test(
  'project settings with leading flags stay pending until the owner confirms',
  async () => {
    const { root } = lab()
    await project([
      'add',
      root,
      '--hydra',
      'lab',
    ])
    const before = loadHydra({ hydraId: 'lab' }).state.projects
    const hydra = ownerOnly({
      commands: { project },
      env: { PNYX_ACTOR: 'hydra' },
    })
    const result = await hydra.project([
      '--hydra',
      'lab',
      'set',
      root,
      '--copy',
      'printf owner-copy',
    ]) as { token: string }
    assert.ok(result.token)
    assert.deepEqual(
      loadHydra({ hydraId: 'lab' }).state.projects,
      before,
    )
    await approval([
      'confirm',
      result.token,
      '--confirm',
      result.token,
      '--hydra',
      'lab',
    ])
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.projects?.[0]?.copy,
      'printf owner-copy',
    )
  },
)

test(
  'an interrupted applying question can be dismissed without executing it again',
  async () => {
    lab()
    const hydra = ownerOnly({
      commands,
      env: { PNYX_ACTOR: 'hydra' },
    })
    const result = hydra.hydra([
      'set',
      '--command',
      'printf once',
      '--hydra',
      'lab',
    ]) as { token: string }
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          meta: {
            actor: 'web',
            at: new Date().toISOString(),
          },
          cardId: '$hydra',
          change: {
            type: 'hydra.dispatch-progress',
            data: {
              token: result.token,
              status: 'applying',
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    rmSync(
      join(
        hydraDir({ hydraId: 'lab' }),
        'snapshot.json',
      ),
      { force: true },
    )
    await assert.rejects(
      approval([
        'confirm',
        result.token,
        '--confirm',
        result.token,
        '--hydra',
        'lab',
      ]),
      /already applying/,
    )
    await approval([
      'dismiss',
      result.token,
      '--hydra',
      'lab',
    ])
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.config?.command,
      undefined,
    )
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.dispatchProposals?.length,
      0,
    )
  },
)
