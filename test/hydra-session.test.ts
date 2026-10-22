import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ownerOnly } from '../src/cli/hydra-session.ts'
import { commands as cli } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { HYDRA_CARD, hydraConfig, hydraEvent } from '../src/core/hydra.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { configPath } from '../src/dispatch/config.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { runCommand } from '../src/integrations/command/run.ts'
import { fakeDispatch } from './dispatch-fixture.ts'

test(
  'the hosted Hydra proposes owner-only commands without applying them',
  () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-owner-only-',
    ))
    const ran: string[][] = []

    // eslint-disable-next-line pnyx/object-params -- runAxiCli owns the command signature.
    const record = (args: string[]) => {
      ran.push(args)

      return {}
    }

    const commands = Object.fromEntries([
      'task',
      'agent',
      'rule',
      'account',
      'hydra',
      'project',
      'setup',
    ]
      .map(name => [
        name,
        record,
      ])) as Record<'task' | 'agent' | 'rule' | 'account' | 'hydra' | 'project' | 'setup', typeof record>
    const hydra = ownerOnly({
      commands,
      env: { PNYX_ACTOR: 'hydra' },
    })

    for (const [
      name,
      args,
    ] of [
        [
          'task',
          [
            'permission',
            '$hydra',
            'r1',
            'allow',
            '--actor',
            'web',
          ],
        ],
        [
          'agent',
          [
            '$hydra',
            'mode',
            'bypassPermissions',
          ],
        ],
        [
          'rule',
          [
            'set',
            'x',
            '--harness',
            'claude',
          ],
        ],
        [
          'account',
          [
            'set',
            'x',
          ],
        ],
        [
          'hydra',
          [
            'set',
            '--command=curl x | sh',
          ],
        ],
        [
          'project',
          [
            'set',
            'demo',
            '--command',
            'sh',
          ],
        ],
        [
          'setup',
          ['hooks'],
        ],
      ] as const) {
      const result = hydra[name]([...args]) as { confirmation: string }
      assert.equal(
        result.confirmation,
        'needed',
        name,
      )
    }

    assert.equal(
      loadHydra({ hydraId: 'default' }).state.dispatchProposals?.length,
      7,
    )
    assert.equal(
      ran.length,
      0,
    )
    hydra.task([
      'permission',
      'ship',
      'r1',
      'allow',
    ])
    hydra.rule(['list'])
    hydra.hydra([
      'set',
      '--name',
      'Renamed',
    ])
    ownerOnly({
      commands,
      env: {},
    }).task([
      'permission',
      '$hydra',
      'r1',
      'allow',
    ])
    assert.equal(
      ran.length,
      4,
    )
  },
)

test(
  'a hosted Hydra in Bypass permissions or Codex never runs owner-only commands at once; other modes and a mid-switch still ask',
  () => {
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
    const meta = {
      at: '2026-10-22T00:00:00Z',
      actor: 'test',
    }

    // The session runs one mode while the owner's composer may already name another.
    const hydraIn = ({
      harness = 'claude',
      running,
      chosen,
    }: {
      harness?: 'claude' | 'codex'
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
    assert.equal(
      ran.length,
      2,
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
      2,
    )
    assert.equal(
      asked(),
      4,
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
      3,
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
      3,
    )
    assert.equal(
      asked(),
      8,
    )
  },
)

test(
  'a command worker never inherits Hydra’s actor',
  async () => {
    const folder = mkdtempSync(join(
      tmpdir(),
      'pnyx-run-',
    ))
    const previous = process.env.PNYX_ACTOR
    process.env.PNYX_ACTOR = 'hydra'

    try {
      runCommand({
        command: 'printf "%s" "${PNYX_ACTOR-unset}" > actor.txt',
        cwd: folder,
        env: {},
      })
    } finally {
      process.env.PNYX_ACTOR = previous
    }

    for (let i = 0; i < 100 && !readFileSync(
      join(
        folder,
        'actor.txt',
      ),
      {
        flag: 'a+',
        encoding: 'utf8',
      },
    ); i++) {
      await new Promise(resolve => setTimeout(
        resolve,
        20,
      ))
    }

    assert.equal(
      readFileSync(
        join(
          folder,
          'actor.txt',
        ),
        'utf8',
      ),
      'unset',
    )
  },
)
