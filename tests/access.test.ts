import { readEvents } from '#app/event-log.ts'
import { withWriter } from '#app/writer.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { workerLine } from './setup/worker-log.ts'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { openPage, startOthrys, until, type Othrys } from './setup/othrys.ts'

let othrys: Othrys

const image = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea735819f0000000049454e44ae426082',
  'hex',
)

beforeAll(async () => {
  othrys = await startOthrys()
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
      port: othrys.port(),
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
    'upgrade',
    (
      response,
      socket,
    ) => {
      socket.destroy()
      resolve({
        status: response.statusCode!,
        body: '',
      })
    },
  )
  sent.once(
    'error',
    reject,
  )
  sent.end()
})

const WEBSOCKET_UPGRADE = {
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-version': '13',
  'sec-websocket-key': Buffer.from('othrys-test-key!').toString('base64'),
}

test(
  'a worker acts as itself: its worker line lands on its own task, and it can move its task with a notice',
  async () => {
    const titan = await othrys.titan()
    const folder = titan.folder({ name: 'app' })
    await titan.owner({
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
    await titan.owner({
      args: [
        'task',
        'start',
        'export',
      ],
    })
    const worker = await titan.agent({ cwd: folder })
    expect(worker.env.OTHRYS_ACTOR).toMatch(/^worker:task-/)
    expect(worker.env.OTHRYS_HOME).toBe(process.env.OTHRYS_HOME)

    await workerLine({
      titan,
      key: 'export',
      line: 'note: Reproduced the bad export',
    })
    expect((await titan.owner({
      args: [
        'task',
        'show',
        'export',
      ],
    })).task.status).toBe('idle')

    const other = await othrys.titan()
    const moved = await titan.as({ session: worker }).run({
      args: [
        'task',
        'move',
        'export',
        '--to-titan',
        other.id,
      ],
    })
    expect(moved.notices).toBeDefined()
    expect((await other.task({ key: 'export' })).worker).not.toContain('none:')
    expect((await fetch(`http://127.0.0.1:${othrys.port()}/titan/${titan.id}/health`)).status).toBe(200)
  },
)

test(
  'Titan changes worker permission mode directly and receives a notice',
  async () => {
    const titan = await othrys.titan()
    await titan.startTask({ key: 'permission-mode' })
    const session = await titan.chat({ text: 'Change the worker mode' })
    const output = await titan.as({ session }).run({
      args: [
        'agent',
        'permission-mode',
        'mode',
        'bypassPermissions',
      ],
    })
    expect(output.notices).toBeDefined()
    const record = await titan.owner({
      args: [
        'task',
        'show',
        'permission-mode',
        '--full',
      ],
    })
    expect(record.task.settings.mode).toBe('bypassPermissions')
    expect((await titan.owner({
      args: [
        'task',
        'show',
        'permission-mode',
      ],
    })).task.notices).toBeDefined()
  },
)

test(
  'Titan\'s own permission request waits for the owner: Titan\'s answer is refused and the owner\'s is accepted once',
  async () => {
    const titan = await othrys.titan()
    const session = await titan.chat({ text: 'clean the build folder' })
    const decision = session.useTool!({
      tool: 'Bash',
      input: { command: 'rm -rf build' },
    })
    const [request] = await until({
      what: 'Titan\'s permission request',
      check: async () => (await titan.owner({
        args: [
          'task',
          'show',
          '$titan',
          '--full',
        ],
      })).task.permissions,
    })
    const answer = [
      'task',
      'permission',
      '$titan',
      request.id,
      'allow',
    ]

    const page = await titan.page()
    expect((await titan.as({ session }).refused({ args: answer })).code).toBe('NO_ROUTE')
    expect((await titan.as({ session }).refused({
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
        'titan',
        '--reason',
        'The build folder is safe to remove',
      ],
    })).toMatchObject({
      type: 'error',
      code: 'NO_ROUTE',
    })
    expect((await titan.owner({
      args: [
        'task',
        'show',
        '$titan',
        '--full',
      ],
    })).task.permissions[0].status).toBe('pending')

    page.close()
    await titan.owner({ args: answer })
    expect(await decision).toMatchObject({ behavior: 'allow' })
    expect((await titan.ownerRefused({ args: answer })).code).toBe('PERMISSION_CLOSED')
  },
)

test(
  'the page\'s socket and files need the local token, its commands stay on its own Titan, and only the Titan\'s own files are served',
  async () => {
    const titan = await othrys.titan()
    await expect(openPage({
      port: othrys.port(),
      titanId: titan.id,
      token: 'wrong-token',
    })).rejects.toThrow()

    const page = await titan.page()
    const elsewhere = await page.send({
      name: 'task',
      args: [
        'list',
        '--titan',
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

    const base = `http://127.0.0.1:${othrys.port()}/titan/${titan.id}`
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
      `/titan/${titan.id}/attachments/../../../../etc/passwd?token=${localToken()}`,
      `/titan/${titan.id}/attachments/%2e%2e%2f%2e%2e%2fsettings%2fevents.jsonl?token=${localToken()}`,
      `/titan/${titan.id}/copies/elsewhere/secret.png?token=${localToken()}`,
    ]) {
      const response = await raw({ path: outside })
      expect(response.status).not.toBe(200)
      expect(response.body).not.toContain('root:')
    }

    const forged = await raw({
      path: `/titan/${titan.id}/health`,
      headers: { host: 'attacker.example' },
    })
    expect(forged.status).toBe(403)
  },
)

test(
  'an image outside the Titan\'s folder is never served, whether asked for through .. or through a linked copy folder',
  async () => {
    const titan = await othrys.titan()
    const home = join(
      process.env.OTHRYS_HOME!,
      'titans',
      titan.id,
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
    // Two real images beside the Titan's folder: one at the home's root, one in a folder a copy links to.
    writeFileSync(
      join(
        process.env.OTHRYS_HOME!,
        'outside.png',
      ),
      image,
    )
    const elsewhere = join(
      process.env.OTHRYS_HOME!,
      `${titan.id}-elsewhere`,
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

    const inside = await raw({ path: `/titan/${titan.id}/copies/app/logo.png?token=${token}` })
    expect(inside.status).toBe(200)

    for (const outside of [
      `/titan/${titan.id}/copies/../../../outside.png?token=${token}`,
      `/titan/${titan.id}/copies/app/../../../../outside.png?token=${token}`,
      `/titan/${titan.id}/copies/linked/secret.png?token=${token}`,
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
    const titan = await othrys.titan()
    const run = ({ authorization }: { authorization?: string } = {}) => fetch(
      `http://127.0.0.1:${othrys.port()}/api/run`,
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
            '--title',
            'Unauthorized',
            '--key',
            'unauthorized',
            '--titan',
            titan.id,
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

    expect((await titan.ownerRefused({
      args: [
        'task',
        'show',
        'unauthorized',
      ],
    })).code).toBe('NOT_FOUND')
    expect((await run({ authorization: `Bearer ${localToken()}` })).status).toBe(200)
    expect((await titan.owner({
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
    await withWriter({
      titanId: id,
      create: true,
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: 1,
            id: 'saved-proposal',
            at: '2026-01-01T00:00:00Z',
            actor: 'titan',
            cardId: '$titan',
            type: 'titan.dispatch-proposed',
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
          },
        })
      },
    })
    const titan = await othrys.titan({
      id,
      create: false,
    })
    const result = await titan.owner({
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
    const progress = readEvents({
      titanId: id,
      types: ['titan.dispatch-progress'],
    }).map(event => ({ status: event.type === 'titan.dispatch-progress' ? event.data.status : undefined }))
    expect(progress).toEqual([])
    expect((await titan.task({ key: 'saved-command-task' })).title).toBe('Saved command task')
    expect(await titan.owner({
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
    await withWriter({
      titanId: id,
      create: true,
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: 1,
            id: 'stale-proposal',
            at: '2026-01-01T00:00:00Z',
            actor: 'titan',
            cardId: '$titan',
            type: 'titan.dispatch-proposed',
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
          },
        })
      },
    })
    const titan = await othrys.titan({
      id,
      create: false,
    })
    await titan.owner({
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
    const result = await titan.ownerRefused({
      args: [
        'approval',
        'confirm',
        'stale-command',
      ],
    })
    expect(result.code).toBe('REVISION_CONFLICT')
    expect((await titan.owner({
      args: [
        'owner',
        'memory',
        'list',
      ],
    })).writable.preferences.text).toBe('Keep the current preference')
    expect(readEvents({
      titanId: id,
      types: ['titan.dispatch-progress'],
    }).map(event => ({ status: event.type === 'titan.dispatch-progress' ? event.data.status : undefined }))).toEqual([])
  },
)

test(
  'a saved approval applies native worker settings once',
  async () => {
    const titan = await othrys.titan()
    await titan.startTask({ key: 'approved-mode' })
    expect((await titan.owner({
      args: [
        'task',
        'show',
        'approved-mode',
        '--full',
      ],
    })).task.settings?.mode).not.toBe('bypassPermissions')
    withWriter({
      titanId: titan.id,
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          id: 'native-mode-proposal',
          seq: writer.state.seq + 1,
          at: new Date().toISOString(),
          actor: 'titan',
          cardId: TITAN_CARD,
          type: 'titan.dispatch-proposed',
          data: {
            token: 'native-mode-approval',
            kind: 'command',
            shared: false,
            before: 'legacy-context',
            value: JSON.stringify({
              name: 'agent',
              args: [
                'approved-mode',
                '--',
                'mode',
                'bypassPermissions',
              ],
              cwd: process.cwd(),
            }),
            summary: 'Apply the saved worker mode',
          },
        },
      }),
    })
    const args = [
      'approval',
      'confirm',
      'native-mode-approval',
      '--event-id',
      'apply-native-mode',
    ]
    const applied = await titan.owner({ args })
    expect(applied.state).toBe('confirmed')
    expect((await titan.owner({
      args: [
        'task',
        'show',
        'approved-mode',
        '--full',
      ],
    })).task.settings.mode).toBe('bypassPermissions')
    expect(await titan.owner({ args })).toMatchObject({ event: 'none: proposal already resolved or missing' })
  },
)

test(
  'a host name in allowedHosts opens the page and its socket as Host and https Origin, while other names, plain http and other origins stay refused',
  async () => {
    const titan = await othrys.titan()
    const name = 'othrys.example.ts.net'
    const page = `/titan/${titan.id}/`
    const proxied = {
      host: name,
      origin: `https://${name}`,
    }
    const setHosts = ({ hosts }: { hosts: string[] }) => titan.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ allowedHosts: hosts }),
      ],
    })

    expect((await raw({
      path: page,
      headers: proxied,
    })).status).toBe(403)

    await setHosts({ hosts: [name] })
    const opened = await until({
      what: 'the server to accept the allowed host',
      check: async () => {
        const response = await raw({
          path: page,
          headers: proxied,
        })

        return response.status === 200 && response
      },
    })
    const token = /<meta name="othrys-token" content="([^"]+)"/.exec(opened.body)?.[1]
    expect(token).toBe(localToken())

    expect((await raw({
      path: `${page}ws?token=${token}`,
      headers: {
        ...proxied,
        ...WEBSOCKET_UPGRADE,
      },
    })).status).toBe(101)
    expect((await raw({
      path: `${page}ws?token=wrong`,
      headers: {
        ...proxied,
        ...WEBSOCKET_UPGRADE,
      },
    })).status).toBe(401)

    for (const headers of [
      { host: 'other.example.ts.net' },
      {
        host: name,
        origin: `http://${name}`,
      },
      {
        host: name,
        origin: 'https://attacker.example',
      },
    ] as Record<string, string>[]) {
      expect((await raw({
        path: page,
        headers,
      })).status).toBe(403)
    }

    expect((await titan.ownerRefused({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ allowedHosts: [`https://${name}`] }),
      ],
    })).code).toBe('VALIDATION_ERROR')

    await setHosts({ hosts: [] })
    await until({
      what: 'the server to refuse the removed host again',
      check: async () => (await raw({
        path: page,
        headers: proxied,
      })).status === 403,
    })
  },
)

test(
  'the page links a web app manifest whose start URL is in scope and whose any and maskable icons are served',
  async () => {
    const titan = await othrys.titan()
    const base = `http://127.0.0.1:${othrys.port()}`
    const html = await (await fetch(`${base}/titan/${titan.id}/`)).text()
    const link = /<link rel="manifest" href="([^"]+)"/.exec(html)?.[1]
    expect(link).toBeDefined()

    const response = await fetch(new URL(
      link!,
      base,
    ))
    expect(response.headers.get('content-type')).toBe('application/manifest+json')
    const manifest = await response.json() as {
      start_url: string
      scope: string
      display: string
      icons: {
        src: string
        sizes: string
        purpose: string
      }[]
    }
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true)
    expect(manifest.display).toBe('standalone')
    expect(new Set(manifest.icons.map(icon => icon.purpose))).toEqual(new Set([
      'any',
      'maskable',
    ]))

    for (const icon of manifest.icons) {
      const image = await fetch(new URL(
        icon.src,
        base,
      ))
      expect(image.headers.get('content-type')).toBe('image/png')
    }

    expect(manifest.icons.map(icon => icon.sizes)).toEqual(expect.arrayContaining([
      '192x192',
      '512x512',
    ]))
  },
)
