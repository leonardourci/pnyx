import assert from 'node:assert/strict'
import { ServerResponse } from 'node:http'
import { test } from 'node:test'
import { localToken } from '../../src/server/state.ts'
import { scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()

test(
  'a missing attachment returns a clean 404 and the daemon keeps serving',
  async () => {
    const s = await pnyx.scenario()
    const base = `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}`
    const name = '00000000-0000-4000-8000-000000000000.png'
    const response = await fetch(
      `${base}/attachments/${name}?token=${localToken()}`,
      { signal: AbortSignal.timeout(3000) },
    )
    assert.equal(
      response.status,
      404,
    )
    assert.deepEqual(
      await response.json(),
      {
        error: 'attachment not found',
        code: 'NOT_FOUND',
      },
    )
    assert.equal(
      (await fetch(`${base}/health`)).status,
      200,
    )
  },
)

for (const path of [
  '/health',
  '/folders?path=',
  '/attachments',
  '/host',
]) {
  test(
    `a handler error in ${path} is logged and contained before headers are sent`,
    async t => {
      const s = await pnyx.scenario()
      const url = `/hydra/${s.hydraId}${path}`
      const original = ServerResponse.prototype.writeHead
      let injected = false
      t.mock.method(
        ServerResponse.prototype,
        'writeHead',
        // eslint-disable-next-line pnyx/object-params -- Node owns ServerResponse.writeHead's signature.
        function (
          this: ServerResponse,
          ...args: Parameters<typeof original>
        ) {
          if (this.req.url?.split('?')[0] === url.split('?')[0] && !injected) {
            injected = true
            throw new Error('response failed')
          }

          return original.apply(
            this,
            args,
          )
        },
      )
      const logged = t.mock.method(
        console,
        'error',
        () => {},
      )
      const response = await fetch(
        `http://127.0.0.1:${pnyx.port()}${url}`,
        path === '/attachments' || path === '/host' ? {
          method: 'POST',
          headers: {
            authorization: `Bearer ${localToken()}`,
            'content-type': path === '/host' ? 'application/json' : 'image/png',
          },
          body: path === '/host' ? JSON.stringify({ action: 'usage' }) : Buffer.from('image'),
        } : undefined,
      )
      assert.equal(
        response.status,
        500,
      )
      assert.equal(
        (await response.json() as { code: string }).code,
        'INTERNAL_ERROR',
      )
      assert.ok(logged.mock.calls.some(call => call.arguments.join(' ').includes(url.split('?')[0]!) && call.arguments.join(' ').includes('response failed')))
      assert.equal(
        (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status,
        200,
      )
    },
  )
}

test(
  'a handler error after headers closes only its response and keeps running workers',
  async t => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'running' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
        '--folder',
        folder,
      ],
    })
    const held = pnyx.codex.plan({
      text: '; silence changes nothing.',
      hold: true,
    })

    try {
      await s.owner({
        args: [
          'task',
          'start',
          'work',
          '--harness',
          'codex',
        ],
      })
      const agent = await s.agent({ cwd: folder })
      await until({
        what: 'worker opening turn',
        check: () => agent.received.length === 1,
      })
      const original = ServerResponse.prototype.writeHead
      const path = `/hydra/${s.hydraId}/health`
      let injected = false
      t.mock.method(
        ServerResponse.prototype,
        'writeHead',
        // eslint-disable-next-line pnyx/object-params -- Node owns ServerResponse.writeHead's signature.
        function (
          this: ServerResponse,
          ...args: Parameters<typeof original>
        ) {
          const result = original.apply(
            this,
            args,
          )

          if (this.req.url === path && !injected) {
            injected = true
            this.flushHeaders()
            throw new Error('failed after headers')
          }

          return result
        },
      )
      const logged = t.mock.method(
        console,
        'error',
        () => {},
      )
      await assert.rejects(async () => {
        const response = await fetch(`http://127.0.0.1:${pnyx.port()}${path}`)
        await response.text()
      })
      assert.ok(logged.mock.calls.some(call => call.arguments.join(' ').includes('failed after headers')))
      assert.equal(
        (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status,
        200,
      )
      assert.equal(
        s.task({ key: 'work' }).sessionActivity,
        'working',
      )
      assert.equal(
        s.received({ cwd: folder }).length,
        1,
      )
    } finally {
      held.release()
    }
  },
)

test(
  'two workers cut by a restart continue once in their existing sessions and a second cut cannot loop',
  async () => {
    const s = await pnyx.scenario()
    const resume = 'Pnyx restarted during your turn; continue from where you stopped.'
    const workers: {
      key: string
      folder: string
      session: string
    }[] = []
    const held = []

    try {
      for (const key of [
        'first',
        'second',
      ]) {
        const folder = s.folder({ name: key })
        await s.owner({
          args: [
            'task',
            'create',
            '--key',
            key,
            '--title',
            key,
            '--folder',
            folder,
          ],
        })
        held.push(pnyx.codex.plan({
          text: '; silence changes nothing.',
          hold: true,
        }))
        await s.owner({
          args: [
            'task',
            'start',
            key,
            '--harness',
            'codex',
          ],
        })
        const agent = await s.agent({ cwd: folder })
        await until({
          what: `${key} opening turn`,
          check: () => agent.received.length === 1,
        })
        workers.push({
          key,
          folder,
          session: agent.id,
        })
        held.push(pnyx.codex.plan({
          text: resume,
          hold: true,
        }))
      }

      await pnyx.restart()

      for (const worker of workers) {
        await until({
          what: `${worker.key} to resume without a message from the owner`,
          check: () => s.received({ cwd: worker.folder }).includes(resume),
        })
        const card = s.task({ key: worker.key })
        assert.equal(
          card.agent?.sessionId,
          worker.session,
        )
        assert.equal(
          card.sessionActivity,
          'working',
        )
        assert.ok(!card.attention.some(item => item.kind === 'interrupted'))
      }

      await pnyx.restart()

      for (const worker of workers) {
        const card = s.task({ key: worker.key })
        assert.equal(
          card.agent?.sessionId,
          worker.session,
        )
        assert.equal(
          card.sessionActivity,
          'interrupted',
        )
        assert.ok(card.attention.some(item => item.kind === 'interrupted'))
        assert.equal(
          s.received({ cwd: worker.folder }).filter(text => text === resume).length,
          1,
        )
        assert.equal(
          s.events().filter(event => event.cardId === card.id && event.id.startsWith('resume:') && event.id.endsWith(':turn')).length,
          1,
        )
      }
    } finally {
      held.forEach(turn => turn.release())
    }
  },
)
