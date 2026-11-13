import assert from 'node:assert/strict'
import fs, { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { decidePush } from '#tasks/push.ts'
import { settle } from '#test-harness/child-fixture.ts'
import type { LatestMessage } from '#hydra/transcripts-read.ts'
import { withWriter } from './writer.ts'
import { emptyHydra, replay } from './reducer.ts'
import { watchedTranscripts } from './latest-feed.ts'
import { loadHydra } from './store.ts'
import { startServer } from './server-daemon.ts'
import { localToken } from './server-state.ts'
import type { RunningServer, ServerMessage } from './server-transport.ts'

test(
  'working and unknown transcripts reach clients, finished watches close and resumed sessions update again',
  async t => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-latest-watches-',
    )))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = join(
      root,
      'home',
    )
    let server: RunningServer | undefined = undefined
    let client: WebSocket | undefined = undefined
    t.after(async () => {
      try {
        client?.close()
        await server?.close()
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()

        if (previous === undefined) {
          delete process.env.PNYX_HOME
        } else {
          process.env.PNYX_HOME = previous
        }

        rmSync(
          root,
          {
            recursive: true,
            force: true,
          },
        )
      }
    })
    const current = join(
      root,
      'working',
      'native.jsonl',
    )
    const unknown = join(
      root,
      'unknown',
      'native.jsonl',
    )
    const finished = join(
      root,
      'finished',
      'native.jsonl',
    )
    const ended = join(
      root,
      'ended',
      'native.jsonl',
    )

    for (const path of [
      current,
      unknown,
      finished,
      ended,
    ]) {
      mkdirSync(
        dirname(path),
        { recursive: true },
      )
      writeFileSync(
        path,
        `${JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'Initial conversation',
          },
        })}\n`,
      )
    }

    const folders = new Set([
      dirname(current),
      dirname(unknown),
      dirname(finished),
      dirname(ended),
    ])
    const openedPolls = new Set<string>()
    const closedPolls = new Set<string>()
    const openedFolders = new Set<string>()
    const closedFolders = new Set<string>()
    const watchFile = fs.watchFile
    t.mock.method(
      fs,
      'watchFile',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.watchFile's signature.
      (...parameters: Parameters<typeof fs.watchFile>) => {
        openedPolls.add(String(parameters[0]))

        return watchFile(...parameters)
      },
    )
    const unwatchFile = fs.unwatchFile
    const watch = fs.watch
    t.mock.method(
      fs,
      'unwatchFile',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.unwatchFile's signature.
      (...parameters: Parameters<typeof fs.unwatchFile>) => {
        closedPolls.add(String(parameters[0]))

        return unwatchFile(...parameters)
      },
    )
    t.mock.method(
      fs,
      'watch',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.watch's signature.
      (...parameters: Parameters<typeof fs.watch>) => {
        const watcher = watch(...parameters)
        const path = String(parameters[0])

        if (folders.has(path)) {
          openedFolders.add(path)
          closedFolders.delete(path)
          watcher.once(
            'close',
            () => closedFolders.add(path),
          )
        }

        return watcher
      },
    )
    syncBuiltinESMExports()
    const put = ({
      key,
      path,
      activity,
    }: {
      key: string
      path: string
      activity?: string
    }) => withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const decision = decidePush({
          state: writer.state,
          key,
          input: {
            title: key,
            activity,
            agent: {
              provider: 'claude-code',
              sessionId: key,
              transcriptPath: path,
            },
          },
          meta: {
            actor: 'fixture',
            at: '2026-11-12T00:00:00Z',
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })

        return decision.event.cardId
      },
    })
    const working = put({
      key: 'working',
      path: current,
      activity: 'working',
    })
    const external = put({
      key: 'unknown',
      path: unknown,
    })
    put({
      key: 'finished',
      path: finished,
      activity: 'finished',
    })
    const endedCard = put({
      key: 'ended',
      path: ended,
      activity: 'ended',
    })
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[endedCard]?.activity,
      'ended',
    )
    server = await startServer({
      port: 0,
      homes: [],
    })
    // The cards are hidden hook cards, so the page asks for hidden cards to receive their latest messages.
    const hidden = encodeURIComponent(JSON.stringify(['--hidden']))
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hydra/default/ws?token=${localToken()}&page=${hidden}`)
    client = ws
    const latest: Record<string, LatestMessage | null> = {}
    let failure: Error | undefined
    ws.on(
      'error',
      error => {
        failure = error
      },
    )
    ws.on(
      'message',
      bytes => {
        const message = JSON.parse(String(bytes)) as ServerMessage

        if (message.type === 'latest') {
          Object.assign(
            latest,
            message.messages,
          )
        }
      },
    )

    await settle({
      what: 'initial conversations over the socket',
      check: () => {
        if (failure) {
          throw failure
        }

        return ws.readyState === WebSocket.OPEN
          && latest[working]?.text === 'Initial conversation'
          && latest[external]?.text === 'Initial conversation'
      },
    })

    for (const path of [
      finished,
      ended,
    ]) {
      assert.equal(
        openedPolls.has(path),
        false,
        'settled sessions start without transcript polling',
      )
      assert.equal(
        openedFolders.has(dirname(path)),
        false,
        'settled sessions start without folder watches',
      )
    }

    const append = ({
      path,
      text,
    }: {
      path: string
      text: string
    }) => appendFileSync(
      path,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: text,
        },
      })}\n`,
    )
    append({
      path: current,
      text: 'Working session update',
    })
    append({
      path: unknown,
      text: 'Unknown external session update',
    })
    await settle({
      what: 'both live transcript updates over the socket',
      check: () =>
        latest[working]?.text === 'Working session update' && latest[external]?.text === 'Unknown external session update',
    })
    put({
      key: 'working',
      path: current,
      activity: 'finished',
    })
    await settle({
      what: 'finished working session resources to close',
      check: () =>
        closedPolls.has(current) && closedFolders.has(dirname(current)),
    })
    put({
      key: 'unknown',
      path: unknown,
      activity: 'finished',
    })
    await settle({
      what: 'finished external session resources to close',
      check: () =>
        closedPolls.has(unknown) && closedFolders.has(dirname(unknown)),
    })
    put({
      key: 'working',
      path: current,
      activity: 'working',
    })
    await settle({
      what: 'resumed session watch to reopen',
      check: () => openedFolders.has(dirname(current)) && !closedFolders.has(dirname(current)),
    })
    append({
      path: current,
      text: 'Resumed session update',
    })
    await settle({
      what: 'resumed transcript update over the socket',
      check: () => latest[working]?.text === 'Resumed session update',
    })
  },
)

test(
  'a hosted session releases its transcript once its task finishes, though its hook card has no activity',
  () => {
    const path = '/synthetic/hosted/native.jsonl'
    const decision = decidePush({
      state: emptyHydra(),
      key: 'hook',
      input: {
        title: 'hook',
        agent: {
          provider: 'claude-code',
          sessionId: 'hosted',
          transcriptPath: path,
          host: 'pnyx',
        },
      },
      meta: {
        actor: 'fixture',
        at: '2026-11-12T00:00:00Z',
      },
    })
    assert.ok('event' in decision)
    const state = replay({
      state: emptyHydra(),
      events: [decision.event],
    })
    const hook = state.cards[decision.event.cardId]!
    const [session] = Object.values(state.sessions ?? {})
    assert.ok(session)
    assert.equal(
      hook.activity,
      undefined,
    )
    // The shape session attachment leaves: the task card mirrors the session the host records turns on.
    state.cards.task = {
      ...structuredClone(hook),
      id: 'task',
      key: 'task',
      sessionIds: [session.id],
      activity: 'working',
      sessionActivity: 'working',
    }
    session.taskId = 'task'
    session.activity = 'working'
    session.sessionActivity = 'working'
    assert.deepEqual(
      [...watchedTranscripts({ state })],
      [path],
    )
    state.cards.task.activity = 'finished'
    state.cards.task.sessionActivity = 'finished'
    session.activity = 'finished'
    session.sessionActivity = 'finished'
    assert.deepEqual(
      [...watchedTranscripts({ state })],
      [],
    )
  },
)
