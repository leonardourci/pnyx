import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ownerOnly } from '../src/cli/hydra-session.ts'
import { commands as cli } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { HYDRA_CARD, hydraConfig, hydraEvent, hydraMode } from '../src/core/hydra.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { configPath } from '../src/dispatch/config.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { fakeDispatch } from './dispatch-fixture.ts'

test(
  'a hosted Hydra in Bypass permissions or Codex never runs owner-only commands at once; other modes and a mid-switch still ask',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-owner-bypass-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    fakeDispatch({ root })
    cli.hydra([
      'create',
      'lab',
    ])
    await cli.task([
      'create',
      '--title',
      'Ship',
      '--key',
      'ship',
      '--hydra',
      'lab',
    ])
    // The inner Hydra guards read the running Hydra from the process environment.
    const previous = process.env.PNYX_HYDRA
    process.env.PNYX_HYDRA = 'lab'
    t.after(() => {
      process.env.PNYX_HYDRA = previous
    })
    const meta = {
      at: '2026-10-22T00:00:00Z',
      actor: 'test',
    }

    // The session runs one mode while the owner's composer may already name another.
    const hydraIn = ({
      harness = 'claude',
      kind = 'agent',
      running,
      chosen,
    }: {
      harness?: 'claude' | 'codex'
      kind?: 'agent' | 'firstmate'
      running: string
      chosen: string
    }) => withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const provider = harness === 'claude' ? 'claude-code' : 'codex'
        const session = decidePush({
          state: writer.state,
          key: `${harness}:hydra-session`,
          input: {
            agent: {
              provider,
              sessionId: 'hydra-session',
              cwd: root,
              host: 'pnyx',
            },
            title: 'Hydra',
            settings: { mode: running },
            source: {
              adapter: 'pnyx',
              objectId: 'hydra-session',
              observedAt: meta.at,
            },
          },
          meta,
        })

        if ('event' in session) {
          writer.append({ event: session.event })
        }

        const config = hydraConfig({ state: writer.state })
        const configured = hydraEvent({
          state: writer.state,
          meta,
          cardId: HYDRA_CARD,
          change: {
            type: 'board.configured',
            data: {
              ...config,
              hydra: {
                ...config.hydra,
                kind,
                session: `${provider}:hydra-session`,
                agent: {
                  harness,
                  mode: chosen,
                },
              },
            },
          },
        })

        if ('event' in configured) {
          writer.append({ event: configured.event })
        }
      },
    })
    const ran: string[][] = []

    // eslint-disable-next-line pnyx/object-params -- runAxiCli owns the command signature.
    const record = (args: string[]) => {
      ran.push(args)

      return {}
    }

    const hydra = ownerOnly({
      commands: {
        setup: record,
        agent: record,
        task: record,
        approval: record,
        rule: dispatchCommands.rule,
      },
      env: {
        PNYX_ACTOR: 'hydra',
        PNYX_HYDRA: 'lab',
      },
    })
    const asked = () => loadHydra({ hydraId: 'lab' }).state.dispatchProposals?.length ?? 0

    hydraIn({
      running: 'bypassPermissions',
      chosen: 'bypassPermissions',
    })
    hydra.setup(['hooks'])
    hydra.agent([
      '$hydra',
      'mode',
      'default',
    ])
    hydra.setup([
      'service',
      '--hydra',
      'lab',
    ])
    hydra.rule([
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
    ])
    assert.deepEqual(
      ran,
      [
        ['hooks'],
        [
          '$hydra',
          'mode',
          'default',
        ],
        ['service'],
      ],
    )
    hydra.rule([
      'init',
      '--actor',
      'hydra',
      '--hydra',
      'lab',
    ])
    const discarded = await ownerOnly({
      commands: { task: cli.task },
      env: {
        PNYX_ACTOR: 'hydra',
        PNYX_HYDRA: 'lab',
      },
    }).task([
      'copy',
      'ship',
      'remove',
      '--discard',
      '--actor',
      'hydra',
      '--hydra',
      'lab',
    ]) as Record<string, unknown>
    assert.equal(
      discarded.confirmation,
      undefined,
    )
    assert.equal(
      JSON.parse(readFileSync(
        configPath({ hydraId: 'lab' }),
        'utf8',
      )).default[0].harness,
      'codex',
    )
    assert.equal(
      asked(),
      0,
    )

    // Another Hydra naming this one with --hydra does not borrow its Bypass.
    assert.equal(
      (ownerOnly({
        commands: { setup: record },
        env: {
          PNYX_ACTOR: 'hydra',
          PNYX_HYDRA: 'other',
        },
      }).setup([
        'hooks',
        '--hydra',
        'lab',
      ]) as { confirmation: string }).confirmation,
      'needed',
    )

    // Its own permission prompts and the owner's approval questions stay the owner's.
    assert.equal(
      (hydra.task([
        'permission',
        '$hydra',
        'r1',
        'allow',
      ]) as { confirmation: string }).confirmation,
      'needed',
    )
    assert.throws(
      () => hydra.approval([
        'confirm',
        'token',
      ]),
      /Only the owner/,
    )

    for (const [
      running,
      chosen,
    ] of [
        [
          'bypassPermissions',
          'default',
        ],
        [
          'default',
          'bypassPermissions',
        ],
        [
          'acceptEdits',
          'acceptEdits',
        ],
      ] as const) {
      hydraIn({
        running,
        chosen,
      })
      assert.equal(
        (hydra.setup(['hooks']) as { confirmation: string }).confirmation,
        'needed',
        `${running} while the composer names ${chosen}`,
      )
    }

    assert.equal(
      ran.length,
      3,
    )
    assert.equal(
      asked(),
      5,
    )

    // Settings written straight to the log reach the reducer unchecked, so a Claude Hydra can carry a never that grants nothing.
    hydraIn({
      running: 'never',
      chosen: 'never',
    })
    assert.equal(
      hydraMode({ state: loadHydra({ hydraId: 'lab' }).state }),
      'never',
    )
    assert.equal(
      (hydra.setup(['hooks']) as { confirmation: string }).confirmation,
      'needed',
    )

    // A Firstmate Hydra is not one Pnyx runs, so the Bypass its settings name grants nothing.
    hydraIn({
      kind: 'firstmate',
      running: 'bypassPermissions',
      chosen: 'bypassPermissions',
    })
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.settings?.mode,
      'bypassPermissions',
    )
    assert.equal(
      (hydra.setup(['hooks']) as { confirmation: string }).confirmation,
      'needed',
    )

    // Codex's never runs with full access, so it counts once the session runs the never the composer names.
    hydraIn({
      harness: 'codex',
      running: 'never',
      chosen: 'never',
    })
    hydra.setup(['hooks'])
    assert.equal(
      ran.length,
      4,
    )
    assert.equal(
      (hydra.task([
        'permission',
        '$hydra',
        'r2',
        'allow',
      ]) as { confirmation: string }).confirmation,
      'needed',
    )

    for (const [
      running,
      chosen,
    ] of [
        [
          'never',
          'on-request',
        ],
        [
          'on-request',
          'never',
        ],
        [
          'untrusted',
          'untrusted',
        ],
      ] as const) {
      hydraIn({
        harness: 'codex',
        running,
        chosen,
      })
      assert.equal(
        (hydra.setup(['hooks']) as { confirmation: string }).confirmation,
        'needed',
        `Codex ${running} while the composer names ${chosen}`,
      )
    }

    assert.equal(
      ran.length,
      4,
    )
    assert.equal(
      asked(),
      11,
    )
  },
)
