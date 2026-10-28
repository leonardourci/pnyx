import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { serviceFile } from './service.ts'

const CLI = join(
  import.meta.dirname,
  '..',
  'cli',
  'pnyx-axi.ts',
)

test(
  'setup check and Hydra digest report the missing login service until its file is installed',
  {
    skip: process.platform !== 'darwin' && process.platform !== 'linux',
  },
  t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-check-service-',
    ))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    const env = {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(
        root,
        'config',
      ),
      CLAUDE_CONFIG_DIR: join(
        root,
        'claude',
      ),
      CODEX_HOME: join(
        root,
        'codex',
      ),
    }
    const run = ({ args }: { args: string[] }) => spawnSync(
      process.execPath,
      [
        '--conditions=source',
        CLI,
        ...args,
      ],
      {
        env,
        encoding: 'utf8',
      },
    )
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
    assert.match(
      fresh.stdout,
      /^ {2}service,[^\n]*,owner,pnyx-axi setup service$/m,
    )
    assert.match(
      run({
        args: [
          'hydra',
          'digest',
        ],
      }).stdout,
      /- service: no login service/,
    )

    const proposal = run({
      args: [
        'setup',
        'service',
        '--preview',
        '--allow-custom-home',
        '--hydra',
        'default',
        '--actor',
        'hydra',
      ],
    })
    assert.equal(
      proposal.status,
      0,
    )
    const token = /^token: (\S+)$/m.exec(proposal.stdout)?.[1]
    assert.ok(token)
    const confirmed = run({
      args: [
        'approval',
        'confirm',
        token,
        '--confirm',
        token,
      ],
    })
    assert.equal(
      confirmed.status,
      0,
    )
    assert.match(
      confirmed.stdout,
      /^state: confirmed$[\s\S]*would install/m,
    )

    const { path } = serviceFile({
      userHome: root,
      configHome: env.XDG_CONFIG_HOME,
    })
    assert.equal(
      existsSync(path),
      false,
    )
    mkdirSync(
      dirname(path),
      { recursive: true },
    )
    writeFileSync(
      path,
      '',
    )
    assert.doesNotMatch(
      run({
        args: [
          'setup',
          'check',
        ],
      }).stdout,
      /^ {2}service,/m,
    )
    assert.doesNotMatch(
      run({
        args: [
          'hydra',
          'digest',
        ],
      }).stdout,
      /- service:/,
    )
  },
)
