import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/app/cli.ts'
import { decidePush } from '../src/core/decide.ts'
import { startServer } from '../src/app/server-daemon.ts'
import { withWriter } from '../src/app/writer.ts'

process.env.PNYX_SEMANTIC = 'off'

test(
  'folder endpoint includes hidden agent History and keeps host and origin guards',
  async () => {
    const home = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-folder-server-',
    )))
    process.env.PNYX_HOME = join(
      home,
      'pnyx',
    )
    const used = join(
      home,
      'used-folder',
    )
    mkdirSync(used)
    commands.hydra([
      'create',
      'default',
      '--name',
      'Work',
    ])
    commands.hydra([
      'create',
      'other',
      '--name',
      'Other',
    ])
    withWriter({
      hydraId: 'other',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          newCardId: 'history-session',
          key: 'history',
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'fixture',
              cwd: used,
            },
          },
          meta: {
            actor: 'test',
            at: '2026-10-15T12:00:00Z',
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const server = await startServer({ port: 0 })

    try {
      const url = `${server.url}folders?path=${encodeURIComponent(home)}`
      const response = await fetch(url)
      assert.equal(
        response.status,
        200,
      )
      const body = await response.json()
      assert.deepEqual(
        body.recent,
        [
          {
            name: 'used-folder',
            path: used,
          },
        ],
      )
      assert.ok(body.folders.some((f: { path: string }) => f.path === used))
      assert.equal(
        (await fetch(
          url,
          { headers: { Origin: 'https://untrusted.example' } },
        )).status,
        403,
      )
      assert.equal(
        (await fetch(
          url,
          { method: 'POST' },
        )).status,
        405,
      )
      assert.equal(
        (await fetch(`${server.url}folders?path=relative`)).status,
        400,
      )
    } finally {
      await server.close(); rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
