import { workerLine } from './setup/worker-log.ts'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { queries } from '#store/zero-schema.ts'
import type { QueryResultType } from '@rocicorp/zero'
import type { HydraState } from '#app/model.ts'
import { openPage, rows, startPnyx, until, type Pnyx } from './setup/pnyx.ts'
import { readRows, zeroReady } from './setup/zero.ts'

let pnyx: Pnyx

const image = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea735819f0000000049454e44ae426082',
  'hex',
)

beforeAll(async () => {
  // The page reads Pnyx's data through zero-cache, which only this file needs.
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'Zero readiness waits through a dropped connection before accepting a ready response',
  async () => {
    let requests = 0
    const probe = createServer((
      req,
      res,
    ) => {
      requests++

      if (requests === 1) {
        req.socket.destroy()

        return
      }

      res.end('ready')
    })
    await new Promise<void>(resolve => probe.listen(
      0,
      '127.0.0.1',
      resolve,
    ))

    try {
      const address = probe.address()

      if (!address || typeof address === 'string') {
        throw new Error('The readiness probe has no address')
      }

      await zeroReady({
        url: `http://127.0.0.1:${address.port}/zero/`,
        cookie: 'readiness=owner',
      })
      expect(requests).toBe(2)
    } finally {
      probe.closeAllConnections()
      await new Promise(resolve => probe.close(resolve))
    }
  },
)

test(
  'a /zero client that drops its socket mid-upgrade leaves the server answering',
  async () => {
    // A reset before the refusal is written fails its write (EPIPE); one after it arrives fails the next read (ECONNRESET).
    for (const resetOnAnswer of [
      false,
      true,
    ]) {
      await new Promise<void>(resolve => {
        const client = connect(
          {
            host: '127.0.0.1',
            port: pnyx.port(),
          },
          () => {
            client.write(`GET /zero/sync HTTP/1.1\r\nHost: 127.0.0.1:${pnyx.port()}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)

            if (!resetOnAnswer) {
              client.resetAndDestroy()
            }
          },
        )
        client.on(
          'data',
          () => client.resetAndDestroy(),
        )
        client.on(
          'error',
          () => undefined,
        )
        client.once(
          'close',
          () => resolve(),
        )
      })
    }

    expect((await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status).toBe(200)
  },
)

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
  'the page reads its rows through /zero only with its cookie, gets a hidden task only as a reference, and never a card\'s private steering',
  async () => {
    const hydra = await pnyx.hydra()
    const steering = 'PRIVATE-STEERING-TEXT'
    const origin = `http://127.0.0.1:${pnyx.port()}`
    const cookie = `${zeroCookieName({ port: pnyx.port() })}=${localToken()}`

    for (const key of [
      'shown',
      'parked',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          key,
          '--key',
          key,
        ],
      })
    }

    await hydra.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'shown',
        'private-1',
        '--text',
        steering,
      ],
    })
    await workerLine({
      hydra,
      key: 'parked',
      line: 'blocked: Waiting on the owner',
    })
    await hydra.owner({
      args: [
        'task',
        'hide',
        'parked',
      ],
    })
    const parked = (await hydra.owner({
      args: [
        'task',
        'show',
        'parked',
      ],
    })).task.id as string

    await zeroReady({
      url: `${origin}/zero/`,
      cookie,
    })
    expect((await fetch(`${origin}/zero/`)).status).toBe(401)
    expect((await fetch(
      `${origin}/zero/`,
      { headers: { cookie: `${zeroCookieName({ port: pnyx.port() })}=wrong` } },
    )).status).toBe(401)

    // zero-cache replicates on its own schedule, so each read waits until the replica holds the last change.
    const board = await until({
      what: 'the board rows to list only the shown task',
      check: async () => {
        const read = await readRows<{ key: string }[]>({
          url: `${origin}/zero`,
          cookie,
          query: ({ zero }) => zero.materialize(queries.board.cards({ hydraId: hydra.id })),
        })

        return read.rows.map(card => card.key).join() === 'shown' && read
      },
    })
    expect(board.frames.some(frame => frame.includes(steering))).toBe(false)

    const references = await until({
      what: 'the hidden task\'s reference to carry its blocked status',
      check: async () => {
        const read = await readRows<{
          id: string
          reference?: { data: { workerLog?: { status?: { code: string } } } }
        }[]>({
          url: `${origin}/zero`,
          cookie,
          query: ({ zero }) => zero.materialize(queries.cards.references({ hydraId: hydra.id })),
        })

        return read.rows.find(row => row.id === parked)?.reference?.data.workerLog?.status?.code === 'blocked' && read
      },
    })
    expect(references.frames.some(frame => frame.includes(steering))).toBe(false)

    // The steering is on the card, so the card's own detail, the Hydra's row and its latest owner message must not carry it either.
    const shown = (await hydra.owner({
      args: [
        'task',
        'show',
        'shown',
      ],
    })).task.id as string
    const detail = await readRows({
      url: `${origin}/zero`,
      cookie,
      query: ({ zero }) => zero.materialize(queries.card.detail({
        hydraId: hydra.id,
        ref: shown,
      })),
    })
    expect(detail.rows).toMatchObject({ key: 'shown' })
    const hydraRow = await readRows({
      url: `${origin}/zero`,
      cookie,
      query: ({ zero }) => zero.materialize(queries.hydra.one({ hydraId: hydra.id })),
    })
    const ownerMessage = await readRows({
      url: `${origin}/zero`,
      cookie,
      query: ({ zero }) => zero.materialize(queries.hydra.ownerMessage({ hydraId: hydra.id })),
    })

    for (const read of [
      detail,
      hydraRow,
      ownerMessage,
    ]) {
      expect(read.frames.some(frame => frame.includes(steering))).toBe(false)
    }
  },
)

test(
  'fresh page reads retain unchanged cards while publishing a changed task',
  async () => {
    type CardRow = QueryResultType<typeof queries.board.cards>[number]
    type HydraRow = NonNullable<QueryResultType<typeof queries.hydra.one>>
    // Web modules are source-only; a runtime import keeps them out of the CLI's TypeScript emit graph.
    const pageRowsModule: string = '#web-app/hydra-rows.ts'
    const { hydraFromRows } = await import(pageRowsModule)
    const hydra = await pnyx.hydra()

    for (const key of [
      'changed',
      'retained',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--key',
          key,
          '--title',
          key,
        ],
      })
    }

    const url = `http://127.0.0.1:${pnyx.port()}/zero`
    const cookie = `${zeroCookieName({ port: pnyx.port() })}=${localToken()}`
    await zeroReady({
      url: `${url}/`,
      cookie,
    })
    const read = () => readRows<CardRow[]>({
      url,
      cookie,
      query: ({ zero }) => zero.materialize(queries.board.cards({ hydraId: hydra.id })),
    })
    const before = await until({
      what: 'both page cards replicate',
      check: async () => {
        const result = await read()

        return result.rows.length === 2 && result.rows
      },
    })
    const identity = await readRows<HydraRow>({
      url,
      cookie,
      query: ({ zero }) => zero.materialize(queries.hydra.one({ hydraId: hydra.id })),
    })
    const previous: HydraState = hydraFromRows({
      hydra: identity.rows,
      cards: before,
      opened: [],
      references: [],
    })
    await hydra.owner({
      args: [
        'task',
        'rename',
        'changed',
        '--title',
        'Changed title',
      ],
    })
    const after = await until({
      what: 'the renamed card replicates',
      check: async () => {
        const result = await read()

        return result.rows.some(row => row.body?.data.title === 'Changed title') && result.rows
      },
    })
    const next: HydraState = hydraFromRows({
      hydra: identity.rows,
      cards: after,
      opened: [],
      references: [],
      previous,
    })
    const changed = next.keys.changed!, retained = next.keys.retained!
    expect(after.find(row => row.id === retained)).not.toBe(before.find(row => row.id === retained))
    expect(next.cards[retained]).toBe(previous.cards[retained])
    expect(next.cards[changed]).not.toBe(previous.cards[changed])
    expect(next.cards[changed]!.title).toBe('Changed title')
  },
)

test(
  'zero-cache replicates only the page\'s tables, so a card\'s private steering and the agent sessions never leave the server',
  async () => {
    const published = rows<{
      tablename: string
      attnames: string[] | null
      rowfilter: string | null
    }>({
      text: 'select tablename, attnames::text[] as attnames, rowfilter from pg_publication_tables where pubname = \'pnyx_page\' order by tablename',
    })
    expect(published.map(table => table.tablename)).toEqual([
      'card_bodies',
      'card_references',
      'cards',
      'columns',
      'declarations',
      'hydra_values',
      'hydras',
      'links',
      'messages',
      'notes',
      'questions',
      'replies',
      'settings',
      'upgrade_status',
    ])
    expect(published.find(table => table.tablename === 'hydras')!.attnames!.sort()).toEqual([
      'config',
      'id',
      'removed',
      'seq',
      'summary',
    ])
    // Only the values the page reads, none of the server's own.
    const keys = [...published.find(table => table.tablename === 'hydra_values')!.rowfilter!.matchAll(/'([A-Za-z]+)'/g)].map(match => match[1])
    expect(keys.sort()).toEqual([
      'configRevision',
      'configured',
      'dispatchProposals',
      'helper',
      'hydraAgent',
      'hydraAgentChange',
      'hydraOperation',
      'hydraStatus',
      'labelColors',
      'projects',
      'projectsRevision',
      'queue',
      'upgrades',
      'view',
      'viewRevision',
    ])
  },
)

test(
  'the page Hydra list excludes a removed Hydra and retains the caller',
  async () => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    const url = `http://127.0.0.1:${pnyx.port()}/zero`
    const cookie = `${zeroCookieName({ port: pnyx.port() })}=${localToken()}`
    await zeroReady({
      url: `${url}/`,
      cookie,
    })
    const result = await until({
      what: 'removed Hydra disappears from page query',
      check: async () => {
        const result = await readRows<{ id: string }[]>({
          url,
          cookie,
          query: ({ zero }) => zero.materialize(queries.hydras.list()),
        })

        const callerPresent = result.rows.some(hydra => hydra.id === caller.id)
        const targetAbsent = !result.rows.some(hydra => hydra.id === target.id)

        return callerPresent && targetAbsent && result.rows
      },
    })
    expect(result).toContainEqual(expect.objectContaining({ id: caller.id }))
    expect(result).not.toContainEqual(expect.objectContaining({ id: target.id }))
  },
)

test(
  'a saved command approval runs once without another confirmation and records its applying claim',
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
      ],
    })
    expect(result.state).toBe('confirmed')
    expect(result.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('target changed') }))
    const progress = rows<{ status: string }>({
      text: "select data->'data'->>'status' as status from events where hydra_id = $1 and type = 'hydra.dispatch-progress'",
      values: [id],
    })
    expect(progress).toEqual([{ status: 'applying' }])
    expect((await hydra.task({ key: 'saved-command-task' })).title).toBe('Saved command task')
    expect(await hydra.owner({
      args: [
        'approval',
        'confirm',
        'saved-command',
      ],
    })).toMatchObject({ event: 'none: proposal already resolved or missing' })
  },
)
