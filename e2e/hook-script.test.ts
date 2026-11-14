import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

const SCRIPT = join(
  import.meta.dirname,
  '..',
  'setup',
  'hooks',
  'pnyx-hook.sh',
)

function runHook({
  home,
  hydra,
  session,
  cwd,
}: {
  home: string
  hydra: string
  session: string
  cwd: string
}): void {
  execFileSync(
    '/bin/sh',
    [
      SCRIPT,
      'claude',
      'UserPromptSubmit',
    ],
    {
      cwd,
      input: JSON.stringify({
        session_id: session,
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Hook from a Hydra without a legacy log',
      }),
      env: {
        PATH: process.env.PATH,
        PNYX_HOME: home,
        PNYX_HYDRA: hydra,
      },
    },
  )
}

test(
  'a hook from a Hydra created after the move to Postgres reaches that Hydra, and an unknown Hydra is still dropped',
  async () => {
    const s = await pnyx.scenario()
    const home = process.env.PNYX_HOME!
    const hydraFolder = join(
      home,
      'hydras',
      s.hydraId,
    )
    assert.equal(
      existsSync(join(
        hydraFolder,
        'events.jsonl',
      )),
      false,
      'a Hydra created now has no legacy log',
    )
    const cwd = s.folder({ name: 'hooked' })
    runHook({
      home,
      hydra: s.hydraId,
      session: 'hook-script-session',
      cwd,
    })
    const card = await until({
      what: 'the hook\'s session to reach the Hydra as a working card',
      check: () => Object.values(s.state().cards).find(c => c.sessionIds?.includes('claude-code:hook-script-session')),
    })
    assert.equal(
      card.sessionActivity,
      'working',
    )

    runHook({
      home,
      hydra: 'never-created',
      session: 'hook-script-unknown',
      cwd,
    })
    assert.equal(
      existsSync(join(
        home,
        'hydras',
        'never-created',
      )),
      false,
      'a hook never starts a Hydra',
    )
  },
)

test(
  'a hook from a Hydra whose server is down is kept in that Hydra\'s spool',
  () => {
    const home = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-hook-spool-',
    )))

    try {
      const spool = join(
        home,
        'hydras',
        'h1',
        'spool',
      )
      mkdirSync(
        join(
          home,
          'hydras',
          'h1',
        ),
        { recursive: true },
      )
      runHook({
        home,
        hydra: 'h1',
        session: 'hook-script-spooled',
        cwd: home,
      })
      const files = readdirSync(spool).filter(name => name.endsWith('.json'))
      assert.equal(
        files.length,
        1,
      )
      assert.match(
        readFileSync(
          join(
            spool,
            files[0]!,
          ),
          'utf8',
        ),
        /"session_id":"hook-script-spooled"/,
      )
    } finally {
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
