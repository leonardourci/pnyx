import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pnyxAxi, serve } from '#test-harness/served.ts'
import { serviceFile } from './service.ts'

test(
  'setup check and Hydra digest report the missing login service until its file is installed',
  {
    skip: process.platform !== 'darwin' && process.platform !== 'linux',
  },
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-check-service-',
    ))
    const previous = {
      PNYX_HOME: process.env.PNYX_HOME,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    }
    // The server runs in this process and looks for the login service under its own HOME.
    Object.assign(
      process.env,
      {
        PNYX_HOME: join(
          root,
          'pnyx',
        ),
        HOME: root,
        XDG_CONFIG_HOME: join(
          root,
          'config',
        ),
      },
    )
    await serve({ t })
    t.after(() => {
      for (const [
        name,
        value,
      ] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
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
    const run = ({ args }: { args: string[] }) => pnyxAxi({
      args,
      env,
    })
    const fresh = await run({
      args: [
        'setup',
        'check',
      ],
    })
    const removed = await run({
      args: [
        'setup',
        'service',
        '--preview',
        '--allow-custom-home',
      ],
    })
    assert.notEqual(
      removed.status,
      0,
    )
    assert.match(
      removed.stdout,
      /unknown setup target: service/,
    )
    assert.equal(
      fresh.status,
      1,
    )
    assert.match(
      fresh.stdout,
      /^ {2}service,[^\n]*,owner,pnyx-axi setup$/m,
    )
    assert.match(
      (await run({
        args: [
          'hydra',
          'digest',
        ],
      })).stdout,
      /- service: no login service/,
    )

    const proposal = await run({
      args: [
        'setup',
        '--preview',
        '--port',
        '4748',
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
    const confirmed = await run({
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
    assert.match(
      confirmed.stdout,
      /4748/,
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
      (await run({
        args: [
          'setup',
          'check',
        ],
      })).stdout,
      /^ {2}service,/m,
    )
    assert.doesNotMatch(
      (await run({
        args: [
          'hydra',
          'digest',
        ],
      })).stdout,
      /- service:/,
    )
  },
)
