import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createServerRoutes } from './server-routes.ts'

test(
  'the removed reminders endpoint follows the unknown-route redirect',
  async t => {
    const route = createServerRoutes({
      hydraId: 'test',
      dir: '/unused',
      url: 'http://127.0.0.1/hydra/test/',
      token: Buffer.from('test'),
      identity: 'test',
    })
    const server = createServer((
      req,
      res,
    ) => {
      route({
        req,
        res,
        path: req.url!,
        search: '',
      })
    })
    t.after(async () => {
      server.close()
      await once(
        server,
        'close',
      )
    })
    server.listen(
      0,
      '127.0.0.1',
    )
    await once(
      server,
      'listening',
    )
    const { port } = server.address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${port}/reminders`,
      { redirect: 'manual' },
    )
    assert.equal(
      response.status,
      302,
    )
    assert.equal(
      response.headers.get('location'),
      '/hydra/test/',
    )
  },
)
