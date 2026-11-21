import { workerLine } from './setup/worker-log.ts'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { openPage, rows, startPnyx, until, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

const image = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea735819f0000000049454e44ae426082',
  'hex',
)

beforeAll(async () => {
  pnyx = await startPnyx()
})

// A request exactly as given: fetch would normalize the path and drop a forged Host header.
const raw = ({
  path,
  headers = {},
}: {
  path: string
  headers?: Record<string, string>
}) => new Promise<{
  status: number
  body: string
}>((
  resolve,
  reject,
) => {
  const sent = request(
    {
      host: '127.0.0.1',
      port: pnyx.port(),
      path,
      headers,
    },
    response => {
      let body = ''
      response.on(
        'data',
        chunk => body += String(chunk),
      )
      response.on(
        'end',
        () => resolve({
          status: response.statusCode!,
          body,
        }),
      )
    },
  )
  sent.once(
    'error',
    reject,
  )
  sent.end()
})

test(
  'a worker acts as itself: its worker line lands on its own task, and it can move its task with a notice',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'app' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Fix the export',
        '--key',
        'export',
        '--folder',
        folder,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'export',
      ],
    })
    const worker = await hydra.agent({ cwd: folder })
    expect(worker.env.PNYX_ACTOR).toMatch(/^worker:task-/)
    expect(worker.env.PNYX_HOME).toBe(process.env.PNYX_HOME)

    await workerLine({
      hydra,
      key: 'export',
      line: 'note: Reproduced the bad export',
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'export',
      ],
    })).task.status).toBe('idle')

    const other = await pnyx.hydra()
    const moved = await hydra.as({ session: worker }).run({
      args: [
        'task',
        'move',
        'export',
        '--to-hydra',
        other.id,
      ],
    })
    expect(moved.notices).toBeDefined()
    expect((await other.task({ key: 'export' })).worker).not.toContain('none:')
    expect((await fetch(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/health`)).status).toBe(200)
  },
)

test(
  'Hydra changes worker permission mode directly and receives a notice',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.startTask({ key: 'permission-mode' })
    const session = await hydra.chat({ text: 'Change the worker mode' })
    const output = await hydra.as({ session }).run({
      args: [
        'agent',
        'permission-mode',
        'mode',
        'bypassPermissions',
      ],
    })
    expect(output.notices).toBeDefined()
    const record = await hydra.owner({
      args: [
        'task',
        'show',
        'permission-mode',
        '--full',
      ],
    })
    expect(record.task.settings.mode).toBe('bypassPermissions')
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'permission-mode',
      ],
    })).task.notices).toBeDefined()
  },
)

test(
  'Hydra\'s own permission request waits for the owner: Hydra\'s answer is refused and the owner\'s is accepted once',
  async () => {
    const hydra = await pnyx.hydra()
    const session = await hydra.chat({ text: 'clean the build folder' })
    const decision = session.useTool!({
      tool: 'Bash',
      input: { command: 'rm -rf build' },
    })
    const [request] = await until({
      what: 'Hydra\'s permission request',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'show',
          '$hydra',
          '--full',
        ],
      })).task.permissions,
    })
    const answer = [
      'task',
      'permission',
      '$hydra',
      request.id,
      'allow',
    ]

    const page = await hydra.page()
    expect((await hydra.as({ session }).refused({ args: answer })).code).toBe('NO_ROUTE')
    expect((await hydra.as({ session }).refused({
      args: [
        ...answer,
        '--actor',
        'cli',
      ],
    })).code).toBe('NO_ROUTE')
    expect(await page.send({
      name: 'task',
      args: [
        ...answer.slice(1),
        '--actor',
        'hydra',
        '--reason',
        'The build folder is safe to remove',
      ],
    })).toMatchObject({
      type: 'error',
      code: 'NO_ROUTE',
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        '$hydra',
        '--full',
      ],
    })).task.permissions[0].status).toBe('pending')

    page.close()
    await hydra.owner({ args: answer })
    expect(await decision).toMatchObject({ behavior: 'allow' })
    expect((await hydra.ownerRefused({ args: answer })).code).toBe('PERMISSION_CLOSED')
  },
)

test(
  'the page\'s socket and files need the local token, its commands stay on its own Hydra, and only the Hydra\'s own files are served',
  async () => {
    const hydra = await pnyx.hydra()
    await expect(openPage({
      port: pnyx.port(),
      hydraId: hydra.id,
      token: 'wrong-token',
    })).rejects.toThrow()

    const page = await hydra.page()
    const elsewhere = await page.send({
      name: 'task',
      args: [
        'list',
        '--hydra',
        'default',
      ],
    })
    expect(elsewhere).toMatchObject({
      type: 'error',
      code: 'VALIDATION_ERROR',
    })

    for (const name of [
      'restart',
      'push',
      'upgrade',
    ]) {
      expect(await page.send({
        name,
        args: [],
      })).toMatchObject({
        type: 'error',
        code: 'NOT_FOUND',
      })
    }

    page.close()

    const base = `http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}`
    const unauthorized = await fetch(
      `${base}/attachments`,
      {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: image,
      },
    )
    expect(unauthorized.status).toBe(401)

    const stored = await fetch(
      `${base}/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          authorization: `Bearer ${localToken()}`,
        },
        body: image,
      },
    )
    expect(stored.status).toBe(200)
    const { path } = await stored.json() as { path: string }
    const name = path.split('/').at(-1)!

    const served = await fetch(`${base}/attachments/${name}?token=${localToken()}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await served.arrayBuffer())).toEqual(image)
    expect((await fetch(`${base}/attachments/${name}`)).status).toBe(401)

    for (const outside of [
      `/hydra/${hydra.id}/attachments/../../../../etc/passwd?token=${localToken()}`,
      `/hydra/${hydra.id}/attachments/%2e%2e%2f%2e%2e%2fsettings%2fevents.jsonl?token=${localToken()}`,
      `/hydra/${hydra.id}/copies/elsewhere/secret.png?token=${localToken()}`,
    ]) {
      const response = await raw({ path: outside })
      expect(response.status).not.toBe(200)
      expect(response.body).not.toContain('root:')
    }

    const forged = await raw({
      path: `/hydra/${hydra.id}/health`,
      headers: { host: 'attacker.example' },
    })
    expect(forged.status).toBe(403)
  },
)

test(
  'an image outside the Hydra\'s folder is never served, whether asked for through .. or through a linked copy folder',
  async () => {
    const hydra = await pnyx.hydra()
    const home = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
    )
    const token = localToken()
    mkdirSync(
      join(
        home,
        'copies',
        'app',
      ),
      { recursive: true },
    )
    writeFileSync(
      join(
        home,
        'copies',
        'app',
        'logo.png',
      ),
      image,
    )
    // Two real images beside the Hydra's folder: one at the home's root, one in a folder a copy links to.
    writeFileSync(
      join(
        process.env.PNYX_HOME!,
        'outside.png',
      ),
      image,
    )
    const elsewhere = join(
      process.env.PNYX_HOME!,
      `${hydra.id}-elsewhere`,
    )
    mkdirSync(elsewhere)
    writeFileSync(
      join(
        elsewhere,
        'secret.png',
      ),
      image,
    )
    symlinkSync(
      elsewhere,
      join(
        home,
        'copies',
        'linked',
      ),
    )

    const inside = await raw({ path: `/hydra/${hydra.id}/copies/app/logo.png?token=${token}` })
    expect(inside.status).toBe(200)

    for (const outside of [
      `/hydra/${hydra.id}/copies/../../../outside.png?token=${token}`,
      `/hydra/${hydra.id}/copies/app/../../../../outside.png?token=${token}`,
      `/hydra/${hydra.id}/copies/linked/secret.png?token=${token}`,
    ]) {
      expect(
        (await raw({ path: outside })).status,
        outside,
      ).toBe(404)
    }
  },
)

test(
  'a command line posted to /api/run needs the local token and writes nothing without it',
  async () => {
    const hydra = await pnyx.hydra()
    const run = ({ authorization }: { authorization?: string } = {}) => fetch(
      `http://127.0.0.1:${pnyx.port()}/api/run`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authorization ? { authorization } : {},
        },
        body: JSON.stringify({
          argv: [
            'task',
            'create',
            '--no-start',
            '--title',
            'Unauthorized',
            '--key',
            'unauthorized',
            '--hydra',
            hydra.id,
          ],
          cwd: process.cwd(),
          env: {},
        }),
      },
    )

    for (const authorization of [
      undefined,
      'Bearer wrong-token',
    ]) {
      const response = await run({ authorization })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' })
    }

    expect((await hydra.ownerRefused({
      args: [
        'task',
        'show',
        'unauthorized',
      ],
    })).code).toBe('NOT_FOUND')
    expect((await run({ authorization: `Bearer ${localToken()}` })).status).toBe(200)
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'unauthorized',
      ],
    })).task.title).toBe('Unauthorized')
  },
)

test(
  'a saved command approval runs once without another confirmation or progress history',
  async () => {
    const id = 'legacy-approval'
    const folder = join(
      process.env.PNYX_HOME!,
      'hydras',
      id,
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    writeFileSync(
      join(
        folder,
        'events.jsonl',
      ),
      `${JSON.stringify({
        v: 1,
        seq: 1,
        id: 'saved-proposal',
        at: '2026-01-01T00:00:00Z',
        actor: 'hydra',
        cardId: '$hydra',
        type: 'hydra.dispatch-proposed',
        data: {
          token: 'saved-command',
          kind: 'command',
          shared: false,
          before: 'old-context',
          value: JSON.stringify({
            name: 'task',
            args: [
              'create',
              '--no-start',
              '--title',
              'Saved command task',
              '--key',
              'saved-command-task',
            ],
            cwd: process.cwd(),
          }),
          summary: 'Create the saved task',
        },
      })}\n`,
    )
    const hydra = await pnyx.hydra({
      id,
      create: false,
    })
    const result = await hydra.owner({
      args: [
        'approval',
        'confirm',
        'saved-command',
        '--event-id',
        'confirm-saved-command',
      ],
    })
    expect(result.state).toBe('confirmed')
    expect(result.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('target changed') }))
    const progress = rows<{ status: string }>({
      text: "select data->'data'->>'status' as status from events where hydra_id = $1 and type = 'hydra.dispatch-progress'",
      values: [id],
    })
    expect(progress).toEqual([])
    expect((await hydra.task({ key: 'saved-command-task' })).title).toBe('Saved command task')
    expect(await hydra.owner({
      args: [
        'approval',
        'confirm',
        'saved-command',
        '--event-id',
        'confirm-saved-command',
      ],
    })).toMatchObject({ event: 'none: proposal already resolved or missing' })
  },
)

test(
  'a saved non-removal approval keeps the child revision-conflict refusal code',
  async () => {
    const id = 'stale-command-approval'
    const folder = join(
      process.env.PNYX_HOME!,
      'hydras',
      id,
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    writeFileSync(
      join(
        folder,
        'events.jsonl',
      ),
      `${JSON.stringify({
        v: 1,
        seq: 1,
        id: 'stale-proposal',
        at: '2026-01-01T00:00:00Z',
        actor: 'hydra',
        cardId: '$hydra',
        type: 'hydra.dispatch-proposed',
        data: {
          token: 'stale-command',
          kind: 'command',
          shared: false,
          before: 'old-context',
          value: JSON.stringify({
            name: 'owner',
            args: [
              'memory',
              'set',
              '--key',
              'preferences',
              '--text',
              'Stale replacement',
              '--if-revision',
              '0',
            ],
            cwd: process.cwd(),
          }),
          summary: 'Replace the owner preference',
        },
      })}\n`,
    )
    const hydra = await pnyx.hydra({
      id,
      create: false,
    })
    await hydra.owner({
      args: [
        'owner',
        'memory',
        'set',
        '--key',
        'preferences',
        '--text',
        'Keep the current preference',
      ],
    })
    const result = await hydra.ownerRefused({
      args: [
        'approval',
        'confirm',
        'stale-command',
      ],
    })
    expect(result.code).toBe('REVISION_CONFLICT')
    expect((await hydra.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable.preferences.text).toBe('Keep the current preference')
    expect(rows<{ status: string }>({
      text: "select data->'data'->>'status' as status from events where hydra_id = $1 and type = 'hydra.dispatch-progress' order by seq",
      values: [id],
    })).toEqual([])
  },
)
