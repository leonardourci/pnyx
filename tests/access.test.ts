import { request } from 'node:http'
import { beforeAll, expect, test } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { queries } from '#store/zero-schema.ts'
import { openPage, pnyxAxi, rows, startPnyx, until, type Pnyx } from './setup/pnyx.ts'
import { readRows, zeroReady } from './setup/zero.ts'

let pnyx: Pnyx

beforeAll(async () => {
  // The page reads Pnyx's data through zero-cache, which only this file needs.
  pnyx = await startPnyx({ zeroCache: true })
})

// The upgrades the page's chat shows for a Hydra.
const upgrades = ({ hydraId }: { hydraId: string }) => rows({
  text: 'select value from hydra_values where hydra_id = $1 and key = \'upgrades\'',
  values: [hydraId],
}).flatMap(row => row.value as unknown[])

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
  'a worker acts as itself: its declaration lands on its own card, and owner-only commands are refused without effect',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'app' })
    await hydra.owner({
      args: [
        'task',
        'create',
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

    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'status',
        'export',
        'working',
        '--note',
        'Reproduced the bad export',
      ],
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'export',
      ],
    })).task.status).toBe('working: Reproduced the bad export')

    for (const args of [
      ['upgrade'],
      [
        'task',
        'move',
        'export',
        '--to-hydra',
        'default',
      ],
    ]) {
      expect((await hydra.as({ session: worker }).refused({ args })).code).toBe('OWNER_ONLY')
    }

    const restart = await pnyxAxi({
      args: ['restart'],
      env: worker.env,
    })
    expect(restart.status).toBe(1)
    expect(restart.stdout).toContain('code: OWNER_ONLY')
    expect((await fetch(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/health`)).status).toBe(200)
  },
)

test(
  'Hydra\'s owner-only commands wait for the owner\'s confirmation instead of running, and only the owner may answer them',
  async () => {
    const hydra = await pnyx.hydra()
    const session = await hydra.chat({ text: 'restart Pnyx for me' })
    const before = await (await fetch(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/health`)).json() as { pid: number }

    const proposed = await hydra.as({ session }).run({ args: ['upgrade'] })
    expect(proposed).toMatchObject({
      confirmation: 'needed',
      action: 'Approve pnyx-axi upgrade ',
    })
    const answer = await hydra.as({ session }).refused({
      args: [
        'approval',
        'confirm',
        proposed.token,
      ],
    })
    expect(answer.code).toBe('OWNER_ONLY')

    const restart = await pnyxAxi({
      args: ['restart'],
      env: session.env,
    })
    expect(restart.status).toBe(0)
    expect(restart.stdout).toContain('confirmation: needed')
    const after = await (await fetch(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/health`)).json() as { pid: number }
    expect(after.pid).toBe(before.pid)

    await hydra.owner({
      args: [
        'approval',
        'dismiss',
        proposed.token,
      ],
    })
    expect((await hydra.owner({
      args: [
        'approval',
        'confirm',
        proposed.token,
      ],
    })).event).toBe('none: proposal already resolved or missing')
    expect(upgrades({ hydraId: hydra.id })).toEqual([])
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
    const image = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea735819f0000000049454e44ae426082',
      'hex',
    )
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
    await hydra.owner({
      args: [
        'task',
        'status',
        'parked',
        'blocked',
        '--note',
        'Waiting on the owner',
      ],
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

    const board = await until({
      what: 'the board rows to list the shown task',
      check: async () => {
        const read = await readRows<{ key: string }[]>({
          url: `${origin}/zero`,
          cookie,
          query: ({ zero }) => zero.materialize(queries.board.cards({ hydraId: hydra.id })),
        })

        return read.rows.length > 0 && read
      },
    })
    expect(board.rows.map(card => card.key)).toEqual(['shown'])
    expect(board.frames.some(frame => frame.includes(steering))).toBe(false)

    const references = await readRows<{
      id: string
      reference?: { data: { status?: { state: string } } }
    }[]>({
      url: `${origin}/zero`,
      cookie,
      query: ({ zero }) => zero.materialize(queries.cards.references({ hydraId: hydra.id })),
    })
    expect(references.rows.find(row => row.id === parked)?.reference?.data.status?.state).toBe('blocked')
    expect(references.frames.some(frame => frame.includes(steering))).toBe(false)
  },
)
