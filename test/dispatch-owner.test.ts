import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { ownerOnly } from '../src/cli/hydra-session.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { fakeDispatch } from './dispatch-fixture.ts'

function lab() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-owner-dispatch-',
  ))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
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
