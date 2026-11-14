import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { queries } from '#store/zero-schema.ts'
import { openPage, pnyxAxi, rows, startPnyx, until, type Pnyx } from './setup/pnyx.ts'
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
  'a worker\'s pnyx-axi writes only to its own task: other tasks, settings, rules, accounts and moves are refused, its own status, question and link work, and Hydra and the owner keep their rights',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({ key: 'mine' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Other task',
        '--key',
        'other',
        '--folder',
        hydra.folder({ name: 'other' }),
      ],
    })
    const mine = await hydra.task({ key: 'mine' })
    const other = await hydra.task({ key: 'other' })
    const asWorker = hydra.as({ session: worker })
    expect(worker.env.PNYX_ACTOR).toBe(`worker:${mine.id}`)
    const otherStatus = other.status
    const fontSize = (await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.fontSize
    const done = await hydra.column({ role: 'done' })

    const refused = {
      'status on another task': [
        'task',
        'status',
        'other',
        'done',
        '--note',
        'not mine',
      ],
      'status on another task by id': [
        'task',
        'status',
        other.id,
        'done',
      ],
      'status on another task claiming to be Hydra': [
        'task',
        'status',
        'other',
        'done',
        '--actor',
        'hydra',
        '--reason',
        'not mine',
      ],
      'status on another task claiming to be its worker': [
        'task',
        'status',
        'other',
        'done',
        '--actor',
        `worker:${other.id}`,
      ],
      'status on its own task claiming to be the owner': [
        'task',
        'status',
        'mine',
        'done',
        '--actor',
        'web',
      ],
      'status through apply': [
        'apply',
        '--json',
        '{}',
      ],
      'a question on another task': [
        'task',
        'ask',
        'other',
        '--question',
        'Which one?',
      ],
      'a link on another task': [
        'link',
        'other',
        '--url',
        'https://example.test/pull/1',
      ],
      'a message about another task': [
        'hydra',
        'send',
        '--task',
        'other',
        '--kind',
        'progress',
        '--text',
        'not mine',
      ],
      'a move of another task': [
        'move',
        'other',
        done,
      ],
      'a move of its own card': [
        'move',
        'mine',
        done,
      ],
      'settings set': [
        'settings',
        'set',
        '--json',
        '{"fontSize":19}',
      ],
      'settings set claiming to be Hydra': [
        'settings',
        'set',
        '--json',
        '{"fontSize":19}',
        '--actor',
        'hydra',
        '--reason',
        'not mine',
      ],
      'a rule change': [
        'rule',
        'remove',
        'build',
      ],
      'an account change': [
        'account',
        'remove',
        'main',
      ],
      'an outcome': [
        'outcome',
        'other',
        'done',
      ],
      'creating a task': [
        'task',
        'create',
        '--title',
        'Another',
      ],
    }

    for (const [
      what,
      args,
    ] of Object.entries(refused)) {
      const refusal = await asWorker.refused({ args })
      expect(
        refusal.code,
        what,
      ).toBe('WORKER_SCOPE')
      expect(
        refusal.error,
        what,
      ).toMatch(/own task|is not a worker's command|--actor/)
    }

    expect((await hydra.task({ key: 'other' })).status).toBe(otherStatus)
    expect((await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.fontSize).toBe(fontSize)

    await asWorker.run({
      args: [
        'task',
        'status',
        'mine',
        'working',
        '--note',
        'On it',
      ],
    })
    expect((await hydra.task({ key: 'mine' })).status).toBe('working: On it')
    await asWorker.run({
      args: [
        'task',
        'status',
        mine.id,
        'working',
        '--note',
        'Still on it',
        '--actor',
        `worker:${mine.id}`,
      ],
    })
    await asWorker.run({
      args: [
        'task',
        'ask',
        'mine',
        '--question',
        'Which parser?',
      ],
    })
    expect((await hydra.task({ key: 'mine' })).questionCount).toBe(1)
    await asWorker.run({
      args: [
        'link',
        'mine',
        '--url',
        'https://github.com/example/repo/pull/1',
      ],
    })
    await asWorker.run({
      args: [
        'hydra',
        'send',
        '--task',
        'mine',
        '--kind',
        'progress',
        '--text',
        'Halfway',
      ],
    })
    await asWorker.run({
      args: [
        'task',
        'show',
        'other',
      ],
    })
    await asWorker.run({
      args: [
        'settings',
        'show',
      ],
    })

    const hydraSession = await hydra.chat({ text: 'Pause the other task and make the text bigger.' })
    const asHydra = hydra.as({ session: hydraSession })
    await asHydra.run({
      args: [
        'task',
        'status',
        'other',
        'paused',
        '--note',
        'Hydra paused it',
        '--reason',
        'the owner asked',
      ],
    })
    expect((await hydra.task({ key: 'other' })).status).toBe('paused: Hydra paused it')
    await asHydra.run({
      args: [
        'settings',
        'set',
        '--json',
        '{"fontSize":19}',
        '--reason',
        'the owner asked',
      ],
    })
    expect((await hydra.owner({
      args: [
        'settings',
        'show',
      ],
    })).settings.fontSize).toBe(19)
    await hydra.owner({
      args: [
        'task',
        'status',
        'other',
        'paused',
        '--note',
        'Owner paused it',
      ],
    })
    expect((await hydra.task({ key: 'other' })).status).toBe('paused: Owner paused it')
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
      action: expect.stringContaining('pnyx-axi upgrade'),
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
    })).event).toMatch(/^none:/)
    expect(upgrades({ hydraId: hydra.id })).toEqual([])
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

    // Hydra runs pnyx-axi unasked, so its answer only becomes a proposal, and an answer made in Hydra's name is refused outright.
    const page = await hydra.page()
    const proposed = await hydra.as({ session }).run({ args: answer })
    expect(proposed.confirmation).toBe('needed')
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
    await hydra.owner({
      args: [
        'approval',
        'confirm',
        proposed.token,
        '--confirm',
        proposed.token,
      ],
    })
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
          reference?: { data: { status?: { state: string } } }
        }[]>({
          url: `${origin}/zero`,
          cookie,
          query: ({ zero }) => zero.materialize(queries.cards.references({ hydraId: hydra.id })),
        })

        return read.rows.find(row => row.id === parked)?.reference?.data.status?.state === 'blocked' && read
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
