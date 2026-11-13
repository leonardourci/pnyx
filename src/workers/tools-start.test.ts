import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { hostRequest } from '#app/host-request.ts'
import { offerHost } from '#app/server-state.ts'
import { holdHydra, loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { runForClient } from '#app/request-context.ts'
import { readEvents } from '#app/event-log.ts'
import { project } from '#projects/cli.ts'
import { planTaskChange } from '#tasks/plans.ts'
import { decidePush } from '#tasks/push.ts'
import { fakeDispatch } from '#test-harness/dispatch-fixture.ts'
import { git, until } from '#test-harness/harness.ts'
import { replayCodex } from '#test-harness/fake-agents.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { recordTools } from './tools.ts'

test(
  'dispatch grants use the launch folder and survive only a successful attachment',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-tools-start-',
    ))
    const previousHome = process.env.PNYX_HOME
    const previousPath = process.env.PATH
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    const cwd = join(
      root,
      'project',
    )
    mkdirSync(cwd)
    const dispatch = fakeDispatch({ root })
    const sessions: ReturnType<typeof claudeNative>[] = []
    const codex = replayCodex({ hydra: () => 'tools-start' })
    const host = createHost({
      hydraId: 'tools-start',
      changed: () => {},
      query: ({ ...request }) => {
        const native = claudeNative()
        sessions.push(native)

        return native.query(request)
      },
      spawnCodex: codex.spawnCodex,
      presence: () => ({
        state: 'gone',
        detail: 'Fixture session ended',
      }),
    })
    const unoffer = offerHost({
      hydraId: 'tools-start',
      ask: ({ body }) => hostRequest({
        host,
        body,
      }),
    })

    const card = ({ key }: { key: string }) => {
      const state = loadHydra({ hydraId: 'tools-start' }).state

      return state.cards[state.keys[key]!]!
    }

    const create = ({ key }: { key: string }) => withWriter({
      hydraId: 'tools-start',
      fn: ({ writer }) => {
        const decision = planTaskChange({
          hydraId: 'tools-start',
          state: writer.state,
          landing: new Map(),
          operation: {
            op: 'task.create',
            key,
            title: key,
            project: cwd,
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const start = ({
      key,
      flags = [],
    }: {
      key: string
      flags?: string[]
    }) => runForClient({
      identity: { PNYX_ACTOR: 'hydra' },
      cwd,
      run: () => commands.task([
        'start',
        card({ key }).id,
        '--harness',
        'claude',
        '--actor',
        'hydra',
        '--reason',
        'Exercise dispatch',
        '--hydra',
        'tools-start',
        ...flags,
      ]),
    })
    let releaseHydra: (() => void) | undefined

    try {
      await commands.hydra([
        'create',
        'tools-start',
      ])
      releaseHydra = holdHydra({
        hydraId: 'tools-start',
        changed: () => {},
      })
      writeFileSync(
        join(
          cwd,
          '.mcp.json',
        ),
        JSON.stringify({ mcpServers: { local: { command: 'fixture-server' } } }),
      )
      // The owner approved the project servers in Claude Code.
      writeFileSync(
        join(
          dispatch.claude,
          'settings.json',
        ),
        JSON.stringify({ enableAllProjectMcpServers: true }),
      )
      git({
        cwd,
        args: [
          'init',
          '-q',
          '-b',
          'main',
        ],
      })
      git({
        cwd,
        args: [
          'add',
          '.mcp.json',
        ],
      })
      git({
        cwd,
        args: [
          'commit',
          '-q',
          '-m',
          'Fixture tools',
        ],
      })
      await project([
        'add',
        cwd,
        '--hydra',
        'tools-start',
      ])

      create({ key: 'catalog' })
      const catalog = await commands.task([
        'tools',
        card({ key: 'catalog' }).id,
        '--available',
        '--harness',
        'claude',
        '--hydra',
        'tools-start',
      ])
      assert.ok((catalog.tools as string[]).includes('mcp:local'))
      await commands.task([
        'tools',
        card({ key: 'catalog' }).id,
        '--grant',
        'mcp:local',
        '--harness',
        'claude',
        '--hydra',
        'tools-start',
      ])
      assert.deepEqual(
        card({ key: 'catalog' }).tools,
        ['mcp:local'],
      )
      create({ key: 'flags' })
      const beforeFlags = readEvents({ hydraId: 'tools-start' }).length

      for (const flags of [
        [
          '--grant',
          'browser',
        ],
        [
          '--revoke',
          'browser',
        ],
        ['--available'],
      ]) {
        await assert.rejects(
          start({
            key: 'flags',
            flags,
          }),
          { code: 'VALIDATION_ERROR' },
        )
        await assert.rejects(
          commands.task([
            'continue',
            card({ key: 'flags' }).id,
            ...flags,
            '--reason',
            'Validate flags',
            '--hydra',
            'tools-start',
          ]),
          { code: 'VALIDATION_ERROR' },
        )
      }

      assert.equal(
        readEvents({ hydraId: 'tools-start' }).length,
        beforeFlags,
      )
      create({ key: 'failed' })
      recordTools({
        hydraId: 'tools-start',
        task: card({ key: 'failed' }).id,
        grant: ['browser'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      await assert.rejects(
        start({
          key: 'failed',
          flags: [
            '--tool',
            'mcp:local',
            '--mode',
            'bypassPermissions',
          ],
        }),
        { code: 'OWNER_ONLY' },
      )
      assert.deepEqual(
        card({ key: 'failed' }).tools,
        ['browser'],
      )
      assert.equal(
        card({ key: 'failed' }).agent,
        undefined,
      )
      await start({ key: 'failed' })
      await until({
        what: 'retry receives its first input',
        check: () => sessions[0]?.incoming.length === 1,
      })
      assert.deepEqual(
        sessions[0]!.options()?.mcpServers,
        {},
      )
      assert.deepEqual(
        card({ key: 'failed' }).tools,
        ['browser'],
      )

      create({ key: 'revision' })
      const revision = card({ key: 'revision' }).revision
      const before = readEvents({ hydraId: 'tools-start' }).length
      await assert.rejects(
        start({
          key: 'revision',
          flags: [
            '--if-revision',
            String(revision - 1),
          ],
        }),
        { code: 'REVISION_CONFLICT' },
        'a stale start without tools is refused too',
      )
      await assert.rejects(
        start({
          key: 'revision',
          flags: [
            '--tool',
            'mcp:local',
            '--if-revision',
            String(revision - 1),
          ],
        }),
        { code: 'REVISION_CONFLICT' },
      )
      assert.equal(
        card({ key: 'revision' }).copy,
        undefined,
      )
      assert.equal(
        readEvents({ hydraId: 'tools-start' }).length,
        before,
      )
      await start({
        key: 'revision',
        flags: [
          '--tool',
          'mcp:local',
          '--if-revision',
          String(revision),
        ],
      })
      await until({
        what: 'new-copy input',
        check: () => sessions[1]?.incoming.length === 1,
      })
      assert.notEqual(
        card({ key: 'revision' }).copy?.path,
        cwd,
      )
      assert.equal(
        card({ key: 'revision' }).copy?.state,
        'active',
      )
      assert.deepEqual(
        sessions[1]!.options()?.mcpServers,
        { local: { command: 'fixture-server' } },
      )
      assert.deepEqual(
        card({ key: 'revision' }).tools,
        ['mcp:local'],
      )

      create({ key: 'unconfigured' })
      recordTools({
        hydraId: 'tools-start',
        task: card({ key: 'unconfigured' }).id,
        grant: ['mcp:elsewhere'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      await assert.rejects(
        start({ key: 'unconfigured' }),
        {
          code: 'TOOL_UNAVAILABLE',
          message: /mcp:elsewhere/,
        },
      )
      assert.equal(
        card({ key: 'unconfigured' }).copy,
        undefined,
        'a saved grant this login lacks is refused before a copy is made',
      )

      const old = join(
        root,
        'old',
      )
      const fresh = join(
        root,
        'fresh',
      )
      mkdirSync(old)
      mkdirSync(fresh)
      writeFileSync(
        join(
          fresh,
          '.mcp.json',
        ),
        JSON.stringify({ mcpServers: { fresh: { command: 'fresh-server' } } }),
      )
      mkdirSync(join(
        fresh,
        '.claude',
      ))
      writeFileSync(
        join(
          fresh,
          '.claude',
          'settings.json',
        ),
        JSON.stringify({ enabledMcpjsonServers: ['fresh'] }),
      )
      create({ key: 'replacement' })
      withWriter({
        hydraId: 'tools-start',
        fn: ({ writer }) => {
          const decision = decidePush({
            state: writer.state,
            key: 'outside',
            input: {
              agent: {
                provider: 'claude-code',
                sessionId: 'outside',
                cwd: old,
                account: 'claude:test',
                loginFolder: dispatch.claude,
              },
              terminal: { tty: '/dev/ttys991' },
            },
            meta: {
              actor: 'cli',
              at: new Date().toISOString(),
            },
          })
          assert.ok('event' in decision)
          writer.append({ event: decision.event })
        },
      })
      await commands.task([
        'attach',
        card({ key: 'replacement' }).id,
        '--session',
        'claude-code:outside',
        '--hydra',
        'tools-start',
      ])
      assert.ok((await host.toolCatalog({
        task: card({ key: 'replacement' }).id,
        harness: 'codex',
      })).includes('browser'))
      await start({
        key: 'replacement',
        flags: [
          '--replace-session',
          'claude-code:outside',
          '--folder',
          fresh,
          '--tool',
          'mcp:fresh',
        ],
      })
      await until({
        what: 'replacement input',
        check: () => sessions[2]?.incoming.length === 1,
      })
      assert.equal(
        card({ key: 'replacement' }).agent?.cwd,
        fresh,
      )
      assert.deepEqual(
        sessions[2]!.options()?.mcpServers,
        { fresh: { command: 'fresh-server' } },
      )
      const conversation = card({ key: 'replacement' }).agent?.sessionId
      await commands.task([
        'tools',
        card({ key: 'replacement' }).id,
        '--grant',
        'browser',
        '--hydra',
        'tools-start',
      ])
      assert.notEqual(
        card({ key: 'replacement' }).toolsApplied,
        card({ key: 'replacement' }).toolsRevision,
      )
      sessions[2]!.fail({ error: new Error('Fixture native exit before idle') })
      await until({
        what: 'native exit retires its session',
        check: () => !host.diagnostics().sessions.some(session => session.taskId === card({ key: 'replacement' }).id),
      })
      host.reconcile({ state: loadHydra({ hydraId: 'tools-start' }).state })
      await until({
        what: 'pending grant retries after native exit',
        check: () => sessions[3]?.incoming.length === 1,
      })
      assert.equal(
        sessions[3]!.options()?.resume,
        conversation,
      )
      await until({
        what: 'retried grant receipt',
        check: () => card({ key: 'replacement' }).toolsApplied === card({ key: 'replacement' }).toolsRevision,
      })
      create({ key: 'concurrent' })
      const launch = () => host.start({
        task: card({ key: 'concurrent' }).id,
        folder: fresh,
        tools: ['browser'],
        id: 'concurrent-start',
        actor: 'cli',
        prompt: 'Work',
        settings: { provider: 'claude-code' },
      })
      const pending = launch()
      recordTools({
        hydraId: 'tools-start',
        task: card({ key: 'concurrent' }).id,
        grant: ['mcp:fresh'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      await assert.rejects(
        pending,
        { code: 'CONFLICT' },
      )
      assert.equal(
        card({ key: 'concurrent' }).agent,
        undefined,
      )
      assert.deepEqual(
        card({ key: 'concurrent' }).tools,
        ['mcp:fresh'],
      )
      await launch()
      await until({
        what: 'retry loads the current selection',
        check: () => sessions[4]?.incoming.length === 1,
      })
      assert.deepEqual(
        sessions[4]!.options()?.mcpServers,
        { fresh: { command: 'fresh-server' } },
      )
      assert.deepEqual(
        card({ key: 'concurrent' }).tools,
        [
          'browser',
          'mcp:fresh',
        ],
      )
      const claim = readFileSync(
        join(
          process.env.PNYX_HOME!,
          'hydras',
          'tools-start',
          'events.jsonl',
        ),
        'utf8',
      ).split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .find(line => line.type === 'log.transaction' && line.id === 'concurrent-start:claim')
      assert.deepEqual(
        claim?.receipt,
        {
          task: card({ key: 'concurrent' }).id,
          duplicate: false,
        },
        'the saved receipt names the card instead of copying it',
      )
      create({ key: 'no-flags' })
      recordTools({
        hydraId: 'tools-start',
        task: card({ key: 'no-flags' }).id,
        grant: ['browser'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      const plainStart = () => host.start({
        task: card({ key: 'no-flags' }).id,
        folder: fresh,
        id: 'plain-concurrent-start',
        actor: 'cli',
        prompt: 'Work',
        settings: { provider: 'claude-code' },
      })
      const plainPending = plainStart()
      recordTools({
        hydraId: 'tools-start',
        task: card({ key: 'no-flags' }).id,
        revoke: ['browser'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      await assert.rejects(
        plainPending,
        { code: 'CONFLICT' },
      )
      assert.equal(
        card({ key: 'no-flags' }).agent,
        undefined,
      )
      await plainStart()
      await until({
        what: 'plain retry receives the revoked selection',
        check: () => sessions[5]?.incoming.length === 1,
      })
      assert.equal(
        sessions[5]!.options()?.env?.CHROME_DEVTOOLS_AXI_SESSION,
        undefined,
      )
      create({ key: 'same-id-plain' })
      create({ key: 'same-id-tools' })
      const sameId = await Promise.allSettled([
        host.start({
          task: card({ key: 'same-id-plain' }).id,
          folder: fresh,
          id: 'same-event',
          actor: 'cli',
          prompt: 'Work',
          settings: { provider: 'claude-code' },
        }),
        host.start({
          task: card({ key: 'same-id-tools' }).id,
          folder: fresh,
          tools: ['browser'],
          id: 'same-event',
          actor: 'cli',
          prompt: 'Work',
          settings: { provider: 'claude-code' },
        }),
      ])
      assert.deepEqual(
        sameId.map(outcome => outcome.status),
        [
          'fulfilled',
          'fulfilled',
        ],
      )
      assert.doesNotThrow(
        () => readEvents({ hydraId: 'tools-start' }),
        'a duplicate tool start leaves the log readable',
      )
      create({ key: 'unstarted' })
      await commands.task([
        'tools',
        card({ key: 'unstarted' }).id,
        '--grant',
        'browser',
        '--hydra',
        'tools-start',
      ])
      assert.deepEqual(
        card({ key: 'unstarted' }).tools,
        ['browser'],
        'granting only browser to a task with no agent needs no harness',
      )
      await assert.rejects(
        commands.task([
          'tools',
          card({ key: 'unstarted' }).id,
          '--grant',
          'mcp:local',
          '--hydra',
          'tools-start',
        ]),
        {
          code: 'VALIDATION_ERROR',
          message: /--harness/,
        },
      )

      const removedCopy = join(
        root,
        'removed-copy',
      )
      create({ key: 'removed-copy' })
      withWriter({
        hydraId: 'tools-start',
        fn: ({ writer }) => {
          const attached = decidePush({
            state: writer.state,
            key: 'removed-copy',
            input: {
              agent: {
                provider: 'claude-code',
                sessionId: 'removed-copy',
                cwd: removedCopy,
                host: 'pnyx',
              },
            },
            meta: {
              actor: 'cli',
              at: new Date().toISOString(),
            },
          })
          assert.ok('event' in attached)
          writer.append({ event: attached.event })
        },
      })
      assert.ok(
        (await host.toolCatalog({
          task: card({ key: 'removed-copy' }).id,
          harness: 'claude',
        })).includes('mcp:local'),
        'an earlier agent folder that is gone falls back to the project for its servers',
      )
    } finally {
      unoffer()
      host.close()
      releaseHydra?.()

      if (previousHome === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previousHome
      }

      process.env.PATH = previousPath
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
