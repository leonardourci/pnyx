import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ServerResponse } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { HYDRA_CARD } from '../src/hydra/identity.ts'
import { hydraEvent } from '../src/hydra/hydra.ts'
import { withWriter } from '../src/app/writer.ts'
import { openPage, until } from '../src/test-harness/harness.ts'
import { pnyx } from '../src/test-harness/pnyx.ts'

test(
  'an owner message while Hydra is down tries the start again; once it works Hydra answers it, then recaps only what no turn took',
  async () => {
    const s = await pnyx.scenario()
    let page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await page.command({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    const say = ({ text }: { text: string }) => page.command({
      name: 'hydra',
      args: [
        'send',
        `--text=${text}`,
      ],
    })
    const finished = () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished'
    await say({ text: 'Hello' })
    await until({
      what: 'Hydra to answer its first message',
      check: finished,
    })
    page.close()
    await pnyx.restart()
    page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    pnyx.codex.control.refuse = 'thread/resume'

    try {
      await say({ text: 'lost to the outage' })
      await until({
        what: 'Hydra down',
        check: () => s.state().hydraStatus?.state === 'down',
      })
    } finally {
      // The server is shared, so a failure here must not leave later flows refused.
      pnyx.codex.control.refuse = undefined
    }

    await say({ text: 'back yet?' })
    // The resumed session only exists once a start works.
    await until({
      what: 'Hydra up',
      check: () => s.state().hydraStatus?.state === 'up',
    })
    const hydra = await s.agent({ hydra: true })
    const recap = await until({
      what: 'the recap after the owner’s turn',
      check: () => hydra.received.find(text => text.includes('back after outage')),
    })
    assert.ok(hydra.received[0]!.includes('back yet?'))
    assert.deepEqual(
      recap.slice(recap.indexOf('<pnyx-wake>')).split('\n')
        .filter(line => line.startsWith('- '))
        .map(line => line.replace(
          /^- \S+: /,
          '',
        )),
      ['lost to the outage'],
    )
    await until({
      what: 'Hydra to finish the recap',
      check: finished,
    })
    assert.equal(
      hydra.received.filter(text => text.includes('back after outage')).length,
      1,
    )
    page.close()
  },
)

test(
  'a failed snapshot write during a helper grant is contained without killing the daemon or losing the batch',
  async t => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
      ],
    })
    await s.chat({ text: 'Keep routine progress quiet.' })
    await until({
      what: 'main to finish',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          cardId: HYDRA_CARD,
          meta: {
            at: new Date().toISOString(),
            actor: 'web',
          },
          change: {
            type: 'board.configured',
            data: {
              ...writer.state.config!,
              helper: {
                harness: 'claude',
                model: 'sonnet',
              },
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const task = s.task({ key: 'work' })
    pnyx.claude.plan({
      text: '',
      reply: JSON.stringify({
        outcomes: [
          {
            task: task.id,
            audience: 'routine',
            summary: 'Progress checked.',
          },
        ],
      }),
    })
    let blocked = false
    const errors = t.mock.method(
      console,
      'error',
      () => {},
    )
    const rename = fs.renameSync
    t.mock.method(
      fs,
      'renameSync',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.renameSync's signature.
      (...args: Parameters<typeof fs.renameSync>) => {
        if (!blocked && String(args[1]).endsWith('/snapshot.json')
          && new Error().stack?.includes('/routine-helper/runner.ts') && Object.keys(s.state().helper?.runs ?? {}).length > 0) {
          blocked = true
          throw Object.assign(
            new Error('snapshot replace failed'),
            { code: 'EIO' },
          )
        }

        return rename(...args)
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll(); syncBuiltinESMExports()
    })
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          cardId: HYDRA_CARD,
          meta: {
            at: new Date().toISOString(),
            actor: `worker:${task.id}`,
          },
          change: {
            type: 'hydra.message',
            data: {
              action: 'send',
              hydra: 'hydra',
              task: task.id,
              kind: 'progress',
              text: 'Progress through a busy writer.',
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    await until({
      what: 'the helper outcome to persist',
      check: () => s.state().helper?.outcomes.some(outcome => outcome.task === task.id && outcome.summary === 'Progress checked.'),
    })
    await until({
      what: 'the helper lease to release',
      check: () => !fs.existsSync(`${process.env.PNYX_HOME}/hydras/${s.hydraId}/helper-lease-${encodeURIComponent(task.id)}.json`),
    })
    assert.ok(blocked)
    assert.equal(
      s.events().filter(event => event.type === 'hydra.helper-started').length,
      1,
    )
    const grants = s.events().filter(event => event.type === 'hydra.helper-started')
    const finishes = s.events().filter(event => event.type === 'hydra.helper-finished')
    assert.equal(
      finishes.length,
      1,
    )
    assert.equal(
      finishes[0]!.data.batch,
      grants[0]!.data.id,
    )
    const progress = s.events().find(event => event.type === 'hydra.message' && event.data.text === 'Progress through a busy writer.')!
    assert.ok(grants[0]!.data.seqs.includes(progress.seq))
    assert.ok(errors.mock.calls.some(call => call.arguments.join(' ').includes('snapshot replace failed')))
    assert.equal(
      (await fetch(`http://127.0.0.1:${pnyx.port()}/health`)).status,
      200,
    )
  },
)

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
