import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ServerResponse } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { withWriter } from '#app/writer.ts'
import { declareTask } from '#tasks/declarations.ts'
import { hydraDir } from '#app/home-migration.ts'
import { snapshotPath } from '#store/storage.ts'
import { spoolWrite } from '#app/spool.ts'
import { QUIET_MS, openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

// A history like a Hydra used for weeks, where every needless load parses and copies megabytes.
const HISTORY_TASKS = 120
const HISTORY_BRIEF = 'Long-running work. '.repeat(1200)

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
    await s.chat({ text: 'Keep routine work quiet.' })
    await until({
      what: 'main to finish',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    await s.owner({
      args: [
        'hydra',
        'set',
        '--helper',
        'claude',
        '--helper-model',
        'sonnet',
      ],
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
        const decision = declareTask({
          state: writer.state,
          ref: task.id,
          status: 'blocked',
          note: 'Blocked behind a busy writer.',
          meta: {
            at: new Date().toISOString(),
            actor: 'cli',
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
    const declared = s.events().find(event => event.type === 'task.declared' && event.data.note === 'Blocked behind a busy writer.')!
    assert.ok(grants[0]!.data.seqs.includes(declared.seq))
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

test(
  'a server over a long Hydra history stops loading it once nothing changes, and still follows the next change',
  async t => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())

    for (let n = 0; n < HISTORY_TASKS; n++) {
      withWriter({
        hydraId: s.hydraId,
        fn: ({ writer }) => {
          const created = hydraEvent({
            state: writer.state,
            cardId: `task-history-${n}`,
            meta: {
              at: new Date().toISOString(),
              actor: 'web',
            },
            change: {
              type: 'task.created',
              data: {
                key: `history-${n}`,
                title: `History ${n}`,
                brief: HISTORY_BRIEF,
              },
            },
          })
          assert.ok('event' in created)
          writer.append({ event: created.event })
        },
      })
      // Let each update reach the page before the fixture can fill the socket's output buffer.
      await page.shows({
        what: `history task ${n}`,
        check: ({ state }) => state.keys[`history-${n}`],
      })
    }

    // Every Hydra load reads its snapshot, so the reads count the server's work on this Hydra.
    const snapshot = snapshotPath({ dir: hydraDir({ hydraId: s.hydraId }) })
    let loads = 0
    let loadedAt = Date.now()
    const read = fs.readFileSync
    t.mock.method(
      fs,
      'readFileSync',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.readFileSync's signature.
      (...args: Parameters<typeof fs.readFileSync>) => {
        if (args[0] === snapshot) {
          loads++
          loadedAt = Date.now()
        }

        return read(...args)
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })

    const settled = () => until({
      what: 'the server to stop loading the unchanged Hydra',
      check: () => Date.now() - loadedAt >= QUIET_MS,
    })

    await settled()
    const idle = loads
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'next',
        '--title',
        'Next',
      ],
    })
    await page.shows({
      what: 'the next task',
      check: ({ state }) => state.keys.next,
    })
    await settled()
    // The server loaded the new task, so the mock sees its loads and the quiet wait above was real.
    assert.ok(loads > idle)
  },
)

test(
  'a quiet hooked worker repeating itself logs each observation compactly, so it never looks stalled, and a late older event stays stale after a restart',
  async () => {
    const s = await pnyx.scenario()
    const session = crypto.randomUUID()
    const start = Date.now() - 330_000
    const hook = ({
      second,
      event,
    }: {
      second: number
      event: string
    }) => spoolWrite({
      hydraId: s.hydraId,
      entry: {
        v: 1,
        id: `hook-quiet-${event}-${second}`,
        at: new Date(start + second * 1000).toISOString(),
        harness: 'claude',
        event,
        payload: {
          session_id: session,
          transcript_path: `/work/home/.claude/projects/-work-repo/${session}.jsonl`,
          cwd: '/work/repo',
          permission_mode: 'default',
          hook_event_name: event,
          tool_name: 'Bash',
          tool_input: { command: 'sleep 600' },
          tool_use_id: 'toolu_quiet',
        },
      },
    })
    const logged = () => s.events()
      .filter(event => (event.type === 'card.pushed' || event.type === 'card.observed')
        && event.data.source?.objectId === session)
      .map(event => ({
        type: event.type,
        second: (Date.parse(event.at) - start) / 1000,
      }))
    const lastSeen = () => Object.values(s.state().sessions ?? {})
      .find(agent => agent.agent.sessionId === session)?.lastSeen

    for (let second = 0; second <= 300; second += 20) {
      hook({
        second,
        event: 'PreToolUse',
      })
    }

    await until({
      what: 'every repeat to be logged',
      check: () => logged().length === 16,
    })
    assert.deepEqual(
      logged(),
      [
        {
          type: 'card.pushed',
          second: 0,
        },
        ...Array.from(
          { length: 15 },
          (
            _,
            index,
          ) => ({
            type: 'card.observed',
            second: (index + 1) * 20,
          }),
        ),
      ],
      'the first report is logged in full and each repeat as its observation time',
    )
    assert.equal(
      lastSeen(),
      new Date(start + 300_000).toISOString(),
      'the worker\'s last sign of life is its newest observation',
    )

    await pnyx.restart()
    hook({
      second: 290,
      event: 'Stop',
    })
    hook({
      second: 320,
      event: 'Stop',
    })
    await until({
      what: 'the worker\'s Stop to be logged',
      check: () => logged().at(-1)?.second === 320,
    })
    assert.deepEqual(
      logged().slice(16),
      [
        {
          type: 'card.pushed',
          second: 320,
        },
      ],
      'the Stop stamped before the newest repeat is stale across the restart',
    )
  },
)
