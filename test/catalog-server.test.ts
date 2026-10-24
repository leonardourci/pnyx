import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { commands } from '../src/cli/commands.ts'
import { hydraConfig, hydraEvent, HYDRA_CARD } from '../src/core/hydra.ts'
import type { QueryFn } from '../src/server/claude.ts'
import { startServer, type ServerMessage } from '../src/server/server.ts'
import { localToken } from '../src/server/state.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import type { Catalog } from '../src/thread/catalog.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

test(
  'WebSocket catalogs merge live Claude builtins, survive unavailable SDK commands and follow the receiving harness',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-catalog-server-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    process.env.PNYX_SEMANTIC = 'off'
    process.env.CLAUDE_CONFIG_DIR = join(
      root,
      'claude',
    )
    process.env.CODEX_HOME = join(
      root,
      'codex',
    )
    fakeDispatch({ root })
    await commands.hydra([
      'create',
      'lab',
      '--hydra',
      'lab',
    ])
    const global = join(
      root,
      '.agents/skills/disk-review',
    )
    mkdirSync(
      global,
      { recursive: true },
    )
    writeFileSync(
      join(
        global,
        'SKILL.md',
      ),
      '---\nname: disk-review\ndescription: Review local files\n---\n',
    )
    const sdk = hydraSdk()
    let mode: 'ready' | 'error' | 'hang' = 'ready'
    let requests = 0
    // eslint-disable-next-line pnyx/object-params -- The SDK owns this callback signature.
    const query = ((args: Parameters<QueryFn>[0]) => Object.assign(
      sdk.query(args),
      {
        supportedCommands: async () => {
          requests++

          if (mode === 'error') {
            throw new Error('SDK command list unavailable')
          }

          if (mode === 'hang') {
            return new Promise<never>(() => {})
          }

          return [
            {
              name: 'compact',
              description: 'Compact the session',
              builtin: true,
            },
            {
              name: 'sdk-skill',
              description: 'Nonbuiltin duplicated by disk',
              builtin: false,
            },
          ]
        },
      },
    )) as QueryFn
    const server = await startServer({
      hydraId: 'lab',
      port: 0,
      homes: [],
      query,
      catalogLocations: {
        home: root,
        claude: process.env.CLAUDE_CONFIG_DIR,
        codex: process.env.CODEX_HOME,
      },
    })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/lab/ws?token=${localToken()}`)
    t.after(async () => {
      ws.terminate()
      await server.close()
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await once(
      ws,
      'open',
    )
    let id = 0
    const catalog = () => new Promise<Catalog>((
      resolve,
      reject,
    ) => {
      const request = `catalog-${++id}`
      const timer = setTimeout(
        () => {
          ws.off(
            'message',
            receive,
          )
          reject(new Error('catalog response timed out'))
        },
        3000,
      )

      // eslint-disable-next-line pnyx/object-params -- WebSocket owns this callback signature.
      const receive = (data: unknown) => {
        const message = JSON.parse(String(data)) as ServerMessage

        if ((message.type !== 'receipt' && message.type !== 'error') || message.id !== request) {
          return
        }

        clearTimeout(timer)
        ws.off(
          'message',
          receive,
        )

        if (message.type === 'error') {
          reject(new Error(JSON.stringify(message)))
        } else {
          resolve((message as unknown as { catalog: Catalog }).catalog)
        }
      }

      ws.on(
        'message',
        receive,
      )
      ws.send(JSON.stringify({
        type: 'command',
        id: request,
        name: 'catalog',
        args: [HYDRA_CARD],
      }))
    })
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.agent,
      undefined,
    )
    const fresh = await catalog()
    assert.ok(fresh.suggestions.some(item => item.command === '/disk-review'))
    assert.equal(
      requests,
      0,
      'first-open disk discovery requires no running SDK session',
    )
    await commands.hydra([
      'send',
      '--hydra',
      'lab',
      '--text',
      'Start the catalog session.',
    ])
    const deadline = Date.now() + 5000

    while (loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.sessionActivity !== 'finished') {
      assert.ok(
        Date.now() < deadline,
        'Claude session did not finish',
      )
      await new Promise(resolve => setTimeout(
        resolve,
        10,
      ))
    }

    const ready = await catalog()
    assert.deepEqual(
      ready.suggestions.filter(item => item.source === 'Agent commands'),
      [
        {
          command: '/compact',
          description: 'Compact the session',
          source: 'Agent commands',
          kind: 'command',
        },
      ],
    )
    assert.ok(ready.suggestions.some(item => item.command === '/disk-review'))
    assert.equal(
      ready.suggestions.some(item => item.command === '/sdk-skill'),
      false,
    )

    for (const unavailable of [
      'error',
      'hang',
    ] as const) {
      mode = unavailable
      const fallback = await catalog()
      assert.ok(
        fallback.suggestions.some(item => item.command === '/disk-review'),
        `${unavailable} must retain disk skills`,
      )
      assert.equal(
        fallback.suggestions.some(item => item.source === 'Agent commands'),
        false,
      )
    }

    assert.equal(
      requests,
      3,
    )
    mode = 'ready'
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const config = hydraConfig({ state: writer.state })
        const decision = hydraEvent({
          state: writer.state,
          cardId: HYDRA_CARD,
          meta: {
            actor: 'test',
            at: new Date().toISOString(),
          },
          change: {
            type: 'board.configured',
            data: {
              ...config,
              hydra: {
                ...config.hydra,
                agent: { harness: 'codex' },
              },
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    let switched = await catalog()
    const switchDeadline = Date.now() + 5000

    while (!switched.suggestions.some(item => item.command === '$disk-review')) {
      assert.ok(
        Date.now() < switchDeadline,
        JSON.stringify(switched),
      )
      await new Promise(resolve => setTimeout(
        resolve,
        20,
      ))
      switched = await catalog()
    }

    assert.ok(switched.suggestions.some(item => item.command === '$disk-review'))
    assert.equal(
      switched.suggestions.some(item => item.source === 'Agent commands'),
      false,
      'Claude commands must not reach the selected Codex harness',
    )
  },
)
