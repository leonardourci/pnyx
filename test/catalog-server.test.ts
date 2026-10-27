import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { commands } from '../src/app/cli.ts'
import { hydraConfig, hydraEvent, HYDRA_CARD } from '../src/core/hydra.ts'
import type { QueryFn } from '../src/server/claude.ts'
import { type ServerMessage } from '../src/app/server-transport.ts'
import { localToken } from '../src/app/server-state.ts'
import { withWriter } from '../src/app/writer.ts'
import { loadHydra } from '../src/app/store.ts'
import type { Catalog } from '../src/thread/catalog.ts'
import { fakeDispatch } from '../src/test-harness/dispatch-fixture.ts'
import { hydraSdk } from '../src/test-harness/hydra-host-fixture.ts'
import { createHost } from '../src/server/host.ts'
import { recordCompaction } from '../src/compaction/record.ts'
import { sessionId } from '../src/core/tasks.ts'
import { hostObserver } from '../src/test-harness/host-observer.ts'

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
    let mode: 'ready' | 'error' | 'hang' | 'slow' = 'ready'
    let requests = 0
    let finishLateLookup = () => {}
    const lateLookup = new Promise<void>(resolve => finishLateLookup = resolve)
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

          if (mode === 'slow') {
            await lateLookup
          }

          return [
            {
              name: 'compact',
              description: mode === 'slow' ? 'Late compact metadata' : 'Compact the session',
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
    const observer = hostObserver({ describe: () => loadHydra({ hydraId: 'lab' }).state })
    const server = await observer.startServer({
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
    assert.ok(
      fresh.suggestions.some(item => item.command === '/compact'),
      'native compact is available before the first turn',
    )
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
    await observer.until({ check: () => loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished' })

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
        fallback.suggestions.some(item => item.command === '/compact'),
        true,
      )
    }

    assert.equal(
      requests,
      3,
    )
    mode = 'slow'
    const timedOut = await catalog()
    assert.equal(
      timedOut.suggestions.find(item => item.command === '/compact')?.description,
      'Compact the session',
    )
    finishLateLookup()
    await observer.until({
      check: () => Object.values(loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]?.compaction?.catalogs ?? {})
        .flat()
        .some(item => item.description === 'Late compact metadata'),
    })

    const reopened = createHost({
      hydraId: 'lab',
      changed() {},
    })

    try {
      const card = loadHydra({ hydraId: 'lab' }).state.cards[HYDRA_CARD]!
      const retained = await reopened.catalogCommands({ card })
      assert.ok(retained.some(item => item.description === 'Late compact metadata'))
      withWriter({
        hydraId: 'lab',
        fn: ({ writer }) => recordCompaction({
          writer,
          card: card.id,
          at: new Date().toISOString(),
          change: {
            kind: 'status',
            operation: {
              id: 'unsupported',
              session: sessionId({ agent: card.agent! }),
              trigger: 'manual',
              state: 'failed',
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              error: 'Method not found: native compact is not supported',
            },
          },
        }),
      })
      const unavailable = await reopened.catalogCommands({ card })
      assert.match(
        unavailable.find(item => item.command === '/compact')!.unavailable!,
        /not supported/,
      )
    } finally {
      reopened.close()
    }

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
    await observer.checkpoint()
    const switched = await catalog()

    assert.ok(switched.suggestions.some(item => item.command === '$disk-review'))
    assert.equal(
      switched.suggestions.some(item => item.command === '/compact'),
      true,
      'the selected Codex harness has its own native compact command',
    )
  },
)
