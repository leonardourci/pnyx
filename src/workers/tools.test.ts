import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeTools } from './claude-tools.ts'
import { toolNames, recordTools } from './tools.ts'
import { runForClient } from '#app/request-context.ts'
import { commands } from '#app/cli.ts'
import { withWriter } from '#app/writer.ts'
import { planTaskChange } from '#tasks/plans.ts'
import { loadHydra } from '#app/store.ts'
import { replay, emptyHydra } from '#app/reducer.ts'
import { readEvents } from '#app/event-log.ts'

function fixture() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-tools-',
  ))
  const home = join(
    root,
    'login',
  )
  const cwd = join(
    root,
    'project',
  )
  mkdirSync(
    home,
    { recursive: true },
  )
  mkdirSync(
    join(
      cwd,
      '.claude',
    ),
    { recursive: true },
  )
  const json = ({
    path,
    value,
  }: {
    path: string
    value: unknown
  }) => writeFileSync(
    path,
    JSON.stringify(value),
  )

  return {
    root,
    home,
    cwd,
    json,
    env: {
      HOME: root,
      CLAUDE_CONFIG_DIR: home,
    },
  }
}

test(
  'Claude selects only named configured tools, keeps plugins disabled by default and isolates login homes',
  async t => {
    const lab = fixture()
    t.after(() => rmSync(
      lab.root,
      {
        recursive: true,
        force: true,
      },
    ))
    const plugin = join(
      lab.root,
      'plugin',
    )
    mkdirSync(plugin)
    mkdirSync(join(
      lab.home,
      'plugins',
    ))
    lab.json({
      path: join(
        lab.home,
        'plugins',
        'installed_plugins.json',
      ),
      value: {
        plugins: {
          'company@installed': [
            {
              installPath: plugin,
              scope: 'user',
            },
          ],
        },
      },
    })
    lab.json({
      path: join(
        plugin,
        '.mcp.json',
      ),
      value: { mcpServers: { bundled: { command: '${CLAUDE_PLUGIN_ROOT}/server' } } },
    })
    lab.json({
      path: join(
        lab.home,
        '.claude.json',
      ),
      value: {
        mcpServers: {
          company: { command: 'configured-command' },
          browser: { command: 'another-browser' },
        },
      },
    })
    lab.json({
      path: join(
        lab.home,
        'settings.json',
      ),
      value: {
        enabledPlugins: {
          'company@installed': true,
          'another@installed': true,
        },
      },
    })
    lab.json({
      path: join(
        lab.cwd,
        '.mcp.json',
      ),
      value: { mcpServers: { project: { command: 'project-server' } } },
    })
    const initial = await claudeTools(lab)
    assert.deepEqual(
      initial.mcpServers,
      {},
    )
    assert.deepEqual(
      initial.enabledPlugins,
      {
        'company@installed': false,
        'another@installed': false,
      },
    )
    const selected = await claudeTools({
      ...lab,
      grants: [
        'mcp:company',
        'plugin:company@installed',
      ],
    })
    assert.deepEqual(
      selected.mcpServers,
      {
        company: { command: 'configured-command' },
        plugin_company_bundled: { command: `${plugin}/server` },
      },
    )
    assert.deepEqual(
      selected.enabledPlugins,
      {
        'company@installed': false,
        'another@installed': false,
      },
    )
    assert.deepEqual(
      selected.localPlugins,
      [
        {
          type: 'local',
          path: plugin,
          skipMcpDiscovery: true,
        },
      ],
    )
    const other = join(
      lab.root,
      'other-login',
    )
    const isolated = await claudeTools({
      cwd: lab.cwd,
      env: {
        HOME: lab.root,
        CLAUDE_CONFIG_DIR: other,
      },
    })
    assert.ok(!isolated.catalog.includes('mcp:company'))
    await assert.rejects(
      claudeTools({
        ...lab,
        grants: ['mcp:missing'],
      }),
      { code: 'TOOL_UNAVAILABLE' },
    )
    assert.throws(
      () => toolNames({ names: ['mcp:line\nbreak'] }),
      { code: 'VALIDATION_ERROR' },
    )
  },
)

test(
  'Hydra grants persist through replay and workers must ask rather than granting themselves tools',
  async t => {
    const lab = fixture()
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = join(
      lab.root,
      'pnyx',
    )
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        lab.root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await commands.hydra([
      'create',
      'tools',
    ])
    const task = withWriter({
      hydraId: 'tools',
      fn: ({ writer }) => {
        const created = planTaskChange({
          state: writer.state,
          hydraId: 'tools',
          landing: new Map(),
          operation: {
            op: 'task.create',
            title: 'Work',
            key: 'work',
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in created)
        writer.append({ event: created.event })

        return created.event.cardId
      },
    })
    const grant = () => recordTools({
      hydraId: 'tools',
      task,
      grant: [
        'browser',
        'mcp:company',
      ],
      meta: {
        actor: 'hydra',
        at: new Date().toISOString(),
      },
    })
    runForClient({
      identity: { PNYX_ACTOR: 'hydra' },
      cwd: lab.cwd,
      run: grant,
    })
    assert.deepEqual(
      loadHydra({ hydraId: 'tools' }).state.cards[task]?.tools,
      [
        'browser',
        'mcp:company',
      ],
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events: readEvents({ hydraId: 'tools' }),
      }).cards[task]?.tools,
      [
        'browser',
        'mcp:company',
      ],
    )
    runForClient({
      identity: { PNYX_ACTOR: 'hydra' },
      cwd: lab.cwd,
      run: () => recordTools({
        hydraId: 'tools',
        task,
        revoke: ['mcp:company'],
        meta: {
          actor: 'hydra',
          at: new Date().toISOString(),
        },
      }),
    })
    assert.deepEqual(
      loadHydra({ hydraId: 'tools' }).state.cards[task]?.tools,
      ['browser'],
    )
    assert.throws(
      () => runForClient({
        identity: {
          PNYX_ACTOR: `worker:${task}`,
          PNYX_TASK: task,
        },
        cwd: lab.cwd,
        run: () => recordTools({
          hydraId: 'tools',
          task,
          grant: ['mcp:company'],
          meta: {
            actor: `worker:${task}`,
            at: new Date().toISOString(),
          },
        }),
      }),
      { code: 'HYDRA_ONLY' },
    )
    assert.throws(
      () => runForClient({
        identity: {
          PNYX_ACTOR: `worker:${task}`,
          PNYX_TASK: task,
        },
        cwd: lab.cwd,
        run: () => recordTools({
          hydraId: 'tools',
          task,
          grant: ['mcp:company'],
          meta: {
            actor: 'hydra',
            at: new Date().toISOString(),
          },
        }),
      }),
      { code: 'HYDRA_ONLY' },
    )
  },
)
