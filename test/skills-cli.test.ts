import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const BIN = join(
  import.meta.dirname,
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)

test(
  'CLI setup and integrations report global readiness in a temporary user home',
  t => {
    const userHome = mkdtempSync(join(
      tmpdir(),
      'pnyx-skills-cli-',
    ))
    t.after(() => rmSync(
      userHome,
      {
        recursive: true,
        force: true,
      },
    ))
    const env = {
      ...process.env,
      HOME: userHome,
      CLAUDE_CONFIG_DIR: join(
        userHome,
        'claude',
      ),
      CODEX_HOME: join(
        userHome,
        'codex',
      ),
      PNYX_HOME: join(
        userHome,
        '.pnyx',
      ),
      PNYX_SEMANTIC: 'off',
      PNYX_PASEO_URL: 'ws://127.0.0.1:1/ws',
    }
    const run = ({ args }: { args: string[] }) => execFileSync(
      process.execPath,
      [
        BIN,
        ...args,
      ],
      {
        env,
        encoding: 'utf8',
      },
    )
    assert.match(
      run({
        args: [
          'setup',
          'skills',
          '--preview',
        ],
      }),
      /nothing written/,
    )
    assert.ok(!existsSync(env.CLAUDE_CONFIG_DIR))
    assert.match(
      run({ args: ['integrations'] }),
      /skills,"missing:/,
    )
    assert.match(
      run({
        args: [
          'setup',
          'skills',
        ],
      }),
      /installed/,
    )
    assert.match(
      run({ args: ['integrations'] }),
      /skills,ready,pnyx-axi setup skills/,
    )
    const worker = join(
      userHome,
      '.agents',
      'skills',
      'pnyx-worker',
    )
    const target = readlinkSync(worker)
    assert.equal(
      resolve(target),
      resolve(
        import.meta.dirname,
        '..',
        'skills',
        'pnyx-worker',
      ),
    )
    unlinkSync(worker)
    symlinkSync(
      join(
        userHome,
        'unrelated-install',
      ),
      worker,
    )
    run({
      args: [
        'setup',
        'skills',
        '--remove',
      ],
    })
    assert.equal(
      readlinkSync(worker),
      join(
        userHome,
        'unrelated-install',
      ),
    )
    assert.match(
      run({ args: ['integrations'] }),
      /conflict:/,
    )
  },
)
