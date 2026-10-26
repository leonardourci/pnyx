import assert from 'node:assert/strict'
import fs from 'node:fs'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { localToken } from '../../src/server/state.ts'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { openPage, scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'a response error after the durable message append still acknowledges the saved message',
  async t => {
    const s = await pnyx.scenario()
    await s.chat({ text: 'Warm main before the save.' })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const rename = fs.renameSync
    let failed = false
    t.mock.method(
      fs,
      'renameSync',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.renameSync's signature.
      (...args: Parameters<typeof fs.renameSync>) => {
        if (!failed && String(args[1]).endsWith(`/hydras/${s.hydraId}/snapshot.json`)) {
          failed = true
          throw new Error('snapshot unavailable after the append')
        }

        return rename(...args)
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      page.close()
    })
    const receipt = await page.command({
      name: 'hydra',
      args: [
        'send',
        '--text=Saved before the snapshot error.',
        '--event-id',
        'saved-before-error',
      ],
    })
    assert.equal(
      failed,
      true,
    )
    assert.equal(
      receipt.saved,
      true,
    )
    assert.equal(
      receipt.state,
      'queued',
    )
    assert.equal(
      s.events().filter(e => e.id === 'saved-before-error').length,
      1,
    )
  },
)

test(
  'an I/O failure without a saved event remains unconfirmed and can retry the same identity',
  async t => {
    const s = await pnyx.scenario()
    await s.chat({ text: 'Warm before the I/O failure.' })
    const ws = new WebSocket(`ws://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/ws?token=${localToken()}`)
    t.after(() => ws.close())
    await once(
      ws,
      'open',
    )
    const open = fs.openSync
    let failed = false
    t.mock.method(
      fs,
      'openSync',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.openSync's signature.
      (...args: Parameters<typeof fs.openSync>) => {
        if (!failed && String(args[0]).endsWith(`/hydras/${s.hydraId}/writer.lock`)) {
          failed = true
          throw Object.assign(
            new Error('writer unavailable'),
            { code: 'EIO' },
          )
        }

        return open(...args)
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })
    const answer = new Promise<Record<string, unknown>>(resolve => ws.on(
      'message',
      data => {
        const message = JSON.parse(String(data))

        if (message.id === 'unconfirmed-command') {
          resolve(message)
        }
      },
    ))
    const args = [
      'send',
      '--text=Retry this exact save.',
      '--event-id',
      'unconfirmed-write',
    ]
    ws.send(JSON.stringify({
      type: 'command',
      id: 'unconfirmed-command',
      name: 'hydra',
      args,
    }))
    const error = await answer
    assert.equal(
      failed,
      true,
    )
    assert.equal(
      error.type,
      'error',
    )
    assert.notEqual(
      error.saved,
      false,
    )
    assert.equal(
      s.events().some(event => event.id === 'unconfirmed-write'),
      false,
    )
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())
    await page.command({
      name: 'hydra',
      args,
    })
    assert.equal(
      s.events().filter(event => event.id === 'unconfirmed-write').length,
      1,
    )
  },
)
