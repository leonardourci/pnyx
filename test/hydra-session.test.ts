import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ownerOnly } from '../src/cli/hydra-session.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { runCommand } from '../src/integrations/command/run.ts'

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
