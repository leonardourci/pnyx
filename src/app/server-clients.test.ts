import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyHydra, reduce } from './reducer.ts'
import { createServerClients } from './server-clients.ts'
import { createHydra } from './server-hydras.ts'
import { MAX_BUFFERED, SOCKET_RETRY_MS, type HydraClient, type ServerMessage } from './server-transport.ts'
import type { CurrentAction } from '#hydra/calls.ts'

test(
  'state, working status, actions and Hydra lists recover after drain without another update',
  t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-client-recovery-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        seq: 1,
        id: 'create',
        at: '2026-11-10T01:20:33Z',
        actor: 'web',
        cardId: '$hydra',
        type: 'task.created',
        data: {
          key: 'hydra',
          title: 'Hydra',
        },
      },
    })
    state.cards.$hydra!.activity = 'working'
    const action: CurrentAction = {
      calls: [
        {
          id: 'command',
          tool: 'Bash',
          command: 'printf checkpoint',
        },
      ],
      done: false,
    }
    const actions: Record<string, CurrentAction> = { $hydra: action }
    const tabs = createServerClients({
      hydraId: 'default',
      state: () => state,
      recent: () => [],
      agents: () => ({
        queue: () => ({
          waiting: [],
          reading: [],
        }),
        usageViews: () => ({}),
      }),
      threadSubscriptions: [],
      bindThread() {},
      refreshThread() {},
      feed: () => ({
        latest: {},
        actions,
      }),
    })
    t.after(() => tabs.close())
    let buffered = MAX_BUFFERED + 1
    const received: ServerMessage[] = []
    const client: HydraClient = {
      OPEN: 1,
      readyState: 1,
      get bufferedAmount() {
        return buffered
      },
      send({ message }) {
        received.push(message)

        if (message.type === 'snapshot') {
          buffered = MAX_BUFFERED + 1
        }
      },
      terminate() {},
    }
    tabs.clients.add(client)
    assert.equal(
      tabs.send({
        ws: client,
        message: {
          type: 'latest',
          messages: {
            $hydra: {
              role: 'assistant',
              text: 'Initial reply',
            },
            other: {
              role: 'assistant',
              text: 'Keep this reply',
            },
            removed: {
              role: 'assistant',
              text: 'Remove this reply',
            },
          },
          actions: {
            $hydra: action,
            other: action,
            removed: action,
          },
        },
      }),
      false,
    )
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {
          $hydra: {
            role: 'assistant',
            text: 'Newest reply',
          },
          removed: null,
        },
        actions: {
          $hydra: null,
          removed: null,
        },
      },
    })
    tabs.sendQueue({ ws: client })
    assert.equal(
      received.length,
      0,
    )
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    const latest = received.find(message => message.type === 'latest')
    assert.ok(latest?.type === 'latest')
    assert.deepEqual(
      latest.messages,
      {
        $hydra: {
          role: 'assistant',
          text: 'Newest reply',
        },
        other: {
          role: 'assistant',
          text: 'Keep this reply',
        },
        removed: null,
      },
    )
    assert.deepEqual(
      latest.actions,
      {
        $hydra: null,
        other: action,
        removed: null,
      },
    )
    const running = received.find(message => message.type === 'hydraQueue')
    assert.ok(running?.type === 'hydraQueue')
    assert.equal(
      running.queue.chat!.working,
      true,
    )

    received.length = 0
    buffered = MAX_BUFFERED + 1
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {
          other: {
            role: 'assistant',
            text: 'Keep the pending reply',
          },
        },
        actions: { other: action },
      },
    })
    buffered = 0
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {
          $hydra: {
            role: 'assistant',
            text: 'A newer direct reply',
          },
        },
        actions: { $hydra: action },
      },
    })
    t.mock.timers.tick(SOCKET_RETRY_MS)
    assert.equal(
      received.length,
      1,
    )
    const direct = received[0]
    assert.ok(direct?.type === 'latest')
    assert.deepEqual(
      direct.messages,
      {
        other: {
          role: 'assistant',
          text: 'Keep the pending reply',
        },
        $hydra: {
          role: 'assistant',
          text: 'A newer direct reply',
        },
      },
    )
    assert.deepEqual(
      direct.actions,
      {
        other: action,
        $hydra: action,
      },
    )

    received.length = 0
    buffered = MAX_BUFFERED + 1
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {},
        actions: { removed: action },
      },
    })
    tabs.send({
      ws: client,
      message: {
        type: 'latest',
        messages: {},
        actions: { removed: null },
      },
    })
    delete actions.$hydra
    const finished = {
      v: 1 as const,
      seq: 2,
      id: 'finished',
      at: '2026-11-10T01:21:28Z',
      actor: 'pnyx',
      cardId: '$hydra',
      type: 'card.pushed' as const,
      data: {
        key: 'hydra',
        activity: 'finished' as const,
      },
    }
    state = reduce({
      state,
      event: finished,
    })
    tabs.broadcast({ event: finished })
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    assert.deepEqual(
      received.map(message => message.type),
      [
        'snapshot',
        'latest',
        'hydraQueue',
      ],
    )
    const snapshot = received.find(message => message.type === 'snapshot')
    assert.ok(snapshot?.type === 'snapshot')
    assert.equal(
      snapshot.state.cards.$hydra!.activity,
      'finished',
    )
    assert.equal(
      snapshot.seq,
      2,
    )
    const stopped = received.find(message => message.type === 'hydraQueue')
    assert.ok(stopped?.type === 'hydraQueue')
    assert.equal(
      stopped.queue.chat!.working,
      false,
    )
    const cleared = received.find(message => message.type === 'latest')
    assert.ok(cleared?.type === 'latest')
    assert.equal(
      cleared.actions.removed,
      null,
    )
    const accepted = received.length
    t.mock.timers.tick(SOCKET_RETRY_MS * 2)
    assert.equal(
      received.length,
      accepted,
      'one oversized snapshot must not cause a resync loop',
    )

    received.length = 0
    buffered = MAX_BUFFERED + 1
    tabs.hydraSubscribers.add(client)
    assert.equal(
      tabs.send({
        ws: client,
        message: {
          type: 'hydras',
          hydraId: 'default',
          hydras: [],
        },
      }),
      false,
    )
    const added = createHydra({ name: 'Fresh list' })
    buffered = 0
    t.mock.timers.tick(SOCKET_RETRY_MS)
    assert.deepEqual(
      received.map(message => message.type),
      [
        'snapshot',
        'latest',
        'hydraQueue',
        'hydras',
      ],
      'a rejected Hydra list must recover without another update',
    )
    const list = received.find(message => message.type === 'hydras')
    assert.ok(list?.type === 'hydras')
    assert.deepEqual(
      list.hydras.map(({
        id,
        name,
      }) => ({
        id,
        name,
      })),
      [
        {
          id: added,
          name: 'Fresh list',
        },
      ],
      'recovery must read the current list instead of sending the stale payload',
    )
  },
)
