import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import type { ServerMessage } from '#app/server-transport.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { openPage, until } from './harness.ts'

test(
  'a flow page fails on close when the server pushed a delta it could not apply',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-harness-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
    })
    t.after(() => {
      server.close()
      process.env.PNYX_HOME = previous
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const page: ThreadPage = {
      card: '$hydra',
      session: 'fixture',
      stream: 'connection',
      version: 1,
      entries: [],
      route: true,
      watching: 'unknown',
    }
    const send = ({
      socket,
      message,
    }: {
      socket: import('ws').WebSocket
      message: ServerMessage
    }) => socket.send(JSON.stringify(message))
    server.on(
      'connection',
      socket => {
        send({
          socket,
          message: {
            type: 'thread',
            thread: page,
          },
        })
        send({
          socket,
          message: {
            type: 'thread.delta',
            delta: {
              base: 5,
              page: {
                ...page,
                version: 6,
              },
              entries: {
                upsert: [],
                remove: [],
              },
              actions: null,
              conversation: null,
            },
          },
        })
        socket.on(
          'message',
          () => send({
            socket,
            message: {
              type: 'thread',
              thread: {
                ...page,
                version: 7,
              },
            },
          }),
        )
      },
    )
    await new Promise(resolve => server.once(
      'listening',
      resolve,
    ))
    const address = server.address()
    assert.ok(typeof address === 'object' && address)
    const opened = await openPage({
      port: address.port,
      hydraId: 'fixture',
    })
    await until({
      what: 'the page after the resync',
      check: () => opened.threads.some(thread => thread.version === 7),
    })
    assert.throws(
      () => opened.close(),
      /delta 5 to 6 on version 1; .*\$hydra version 7/s,
    )
  },
)
