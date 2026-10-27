import { SET_UP_SKILL } from '../src/integrations/skills/names.ts'
// `pnyx-axi setup check` and the digest's Setup needed list. Every path lives in a
// temporary folder: tests never read or edit the real ~/.claude, ~/.codex or ~/.pnyx.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

process.env.PNYX_SEMANTIC = 'off'

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)

function sandbox() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-s-',
  ))
  const bin = join(
    root,
    'bin',
  )
  mkdirSync(bin)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    PNYX_HOME: join(
      root,
      '.pnyx',
    ),
    CLAUDE_CONFIG_DIR: join(
      root,
      '.claude',
    ),
    CODEX_HOME: join(
      root,
      '.codex',
    ),
    // The machine's own quota-axi stays off PATH so the sandbox decides whether it is installed.
    PATH: [
      bin,
      ...(process.env.PATH ?? '').split(delimiter).filter(dir => dir && !existsSync(join(
        dir,
        'quota-axi',
      ))),
    ].join(delimiter),
  }
  delete env.PNYX_ACTOR

  const run = ({
    args,
    hydra = false,
  }: {
    args: string[]
    hydra?: boolean
  }) => {
    try {
      return {
        status: 0,
        out: execFileSync(
          process.execPath,
          [
            BIN,
            ...args,
          ],
          {
            env: hydra ? {
              ...env,
              PNYX_ACTOR: 'hydra',
            } : env,
            encoding: 'utf8',
          },
        ),
      }
    } catch (error) {
      const failed = error as {
        status: number
        stdout: string
      }

      return {
        status: failed.status,
        out: failed.stdout,
      }
    }
  }

  return {
    root,
    bin,
    env,
    run,
  }
}

test(
  'a fresh home lists what is missing, Hydra creates the config and owner steps become questions',
  () => {
    const {
      root,
      run,
    } = sandbox()
    const project = join(
      root,
      'app',
    )
    mkdirSync(project)
    writeFileSync(
      join(
        project,
        'AGENTS.md',
      ),
      '# App\n',
    )
    run({
      args: [
        'project',
        'add',
        project,
      ],
    })
    const fresh = run({
      args: [
        'setup',
        'check',
      ],
    })
    assert.equal(
      fresh.status,
      1,
    )

    for (const row of [
      /^ {2}config,.*,hydra,pnyx-axi rule init --shared --hydra default$/m,
      /^ {2}"login:claude",.*,owner,/m,
      /^ {2}"login:codex",.*,owner,/m,
      /^ {2}hooks,[^\n]*,owner,pnyx-axi setup hooks/m,
      /^ {2}skills,"missing: \d+ global skill links",owner,pnyx-axi setup skills/m,
      /^ {2}"?quota-axi"?,[^\n]*,owner,/m,
      // An attached project without a profile is a row Hydra fixes itself.
      /^ {2}"profile:app",project app has no profile,hydra,/m,
    ]) {
      assert.match(
        fresh.out,
        row,
      )
    }

    assert.equal(
      /^ {2}service,/m.test(fresh.out),
      process.platform === 'darwin',
    )
    assert.match(
      run({
        args: [
          'hydra',
          'digest',
        ],
      }).out,
      new RegExp(
        String.raw`^Setup needed \(load ${SET_UP_SKILL}\):\n- config: .* · you: pnyx-axi rule init`,
        'm',
      ),
    )

    // The check only reads, so Hydra runs it without a question.
    assert.equal(
      run({
        args: [
          'setup',
          'check',
        ],
        hydra: true,
      }).status,
      1,
    )
    assert.match(
      run({
        args: [
          'rule',
          'init',
          '--shared',
          '--reason',
          'first-run setup',
        ],
        hydra: true,
      }).out,
      /^dispatch: .*hydra-heads-dispatch\.json$/m,
    )

    const after = run({
      args: [
        'setup',
        'check',
      ],
    }).out
    assert.doesNotMatch(
      after,
      /^ {2}config,/m,
    )
    // The starter registry names accounts; each missing login folder is its own row, not a second login row.
    assert.match(
      after,
      /^ {2}"account:claude:personal",[^\n]*,owner,[^\n]*pnyx-axi account remove claude:personal --shared/m,
    )
    assert.doesNotMatch(
      after,
      /"login:/,
    )

    // Without --shared, init would write a per-Hydra config that replaces the owner's rules and accounts.
    assert.match(
      run({
        args: [
          'rule',
          'init',
        ],
        hydra: true,
      }).out,
      /^confirmation: needed$/m,
    )

    // With accounts registered, a harness with none needs its login registered, not just signed in.
    run({
      args: [
        'account',
        'remove',
        'codex:personal',
        '--shared',
      ],
    })
    assert.match(
      run({
        args: [
          'setup',
          'check',
        ],
      }).out,
      /^ {2}"login:codex",[^\n]*,owner,[^\n]*pnyx-axi account set codex:personal --provider codex/m,
    )

    assert.match(
      run({
        args: [
          'setup',
          'hooks',
        ],
        hydra: true,
      }).out,
      /^confirmation: needed$/m,
    )
  },
)
