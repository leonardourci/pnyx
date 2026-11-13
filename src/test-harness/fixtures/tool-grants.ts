import { COPY_LEASE_PREFIX } from '#projects/copy-lease.ts'
import { taskLease } from '#routine-helper/leases.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { fakeDispatch } from '#test-harness/dispatch-fixture.ts'
import { offerHost } from '#app/server-state.ts'
import { hostRequest } from '#app/host-request.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { withWriter } from '#app/writer.ts'
import { loadHydra } from '#app/store.ts'
import { runForClient } from '#app/request-context.ts'
import { planTaskChange } from '#tasks/plans.ts'
import { decidePush } from '#tasks/push.ts'
import { recordTools } from '#workers/tools.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { claudeRecording, replayCodex } from '#test-harness/fake-agents.ts'
import { settle } from '#test-harness/child-fixture.ts'
import type { QueryFn } from '#workers/claude.ts'

fakeDispatch({ root: process.env.HOME! })
process.env.CHROME_DEVTOOLS_AXI_SESSION = 'inherited-session'
process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = 'http://127.0.0.1:1'
process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = 'inherited-credential'

const login = process.env.CLAUDE_CONFIG_DIR!
mkdirSync(
  login,
  { recursive: true },
)
writeFileSync(
  join(
    login,
    '.claude.json',
  ),
  JSON.stringify({
    mcpServers: {
      'unrelated.server': { command: 'synthetic-mcp' },
      unused: { command: 'unused' },
    },
  }),
)
writeFileSync(
  join(
    login,
    'settings.json',
  ),
  JSON.stringify({ enabledPlugins: { 'unused@fixture': true } }),
)
const plugin = join(
  process.env.HOME!,
  'plugin',
)
mkdirSync(
  join(
    plugin,
    '.claude-plugin',
  ),
  { recursive: true },
)
mkdirSync(
  join(
    login,
    'plugins',
  ),
  { recursive: true },
)
writeFileSync(
  join(
    plugin,
    '.claude-plugin',
    'plugin.json',
  ),
  JSON.stringify({ name: 'company' }),
)
writeFileSync(
  join(
    plugin,
    '.mcp.json',
  ),
  JSON.stringify({ mcpServers: { bundled: { command: '${CLAUDE_PLUGIN_ROOT}/server' } } }),
)
writeFileSync(
  join(
    login,
    'plugins',
    'installed_plugins.json',
  ),
  JSON.stringify({
    plugins: {
      'company@fixture': [
        {
          scope: 'user',
          installPath: plugin,
        },
      ],
    },
  }),
)
const result = claudeRecording.turn.find(message => message.type === 'result')
assert.ok(result?.type === 'result' && result.subtype === 'success')

for (const harness of [
  'claude',
  'codex',
] as const) {
  const hydraId = `tools-${harness}`
  await commands.hydra([
    'create',
    hydraId,
  ])
  const claude: ReturnType<typeof claudeNative>[] = []
  const native = replayCodex({
    hydra: () => hydraId,
    configuration: {
      mcp_servers: { 'unrelated.server': { command: 'synthetic-mcp' } },
      plugins: {
        'company@fixture': {
          enabled: true,
          mcp_servers: { bundled: { enabled: true } },
        },
        'unused@fixture': {
          enabled: true,
          mcp_servers: { unused: { enabled: true } },
        },
      },
    },
  })
  const first = native.plan({
    text: 'Work',
    hold: true,
  })
  const grantTurn = native.plan({
    hold: true,
  })

  const query: QueryFn = ({
    prompt,
    options,
  }) => {
    const session = claudeNative()
    claude.push(session)

    return session.query({
      prompt,
      options,
    })
  }

  let host = createHost({
    hydraId,
    query,
    spawnCodex: native.spawnCodex,
    changed: () => {},
    wakeDelay: 3_600_000,
  })
  let releaseCopyLease: (() => void) | undefined
  let recoveredTurn: ReturnType<typeof native.plan> | undefined
  const sessionId = `${harness}-conversation`
  const task = withWriter({
    hydraId,
    fn: ({ writer }) => {
      const created = planTaskChange({
        hydraId,
        state: writer.state,
        landing: new Map(),
        operation: {
          op: 'task.create',
          key: 'worker',
          title: 'Worker',
        },
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in created)
      writer.append({ event: created.event })
      const attached = decidePush({
        state: writer.state,
        key: 'worker',
        input: {
          agent: {
            provider: harness === 'claude' ? 'claude-code' : 'codex',
            sessionId,
            cwd: process.env.HOME,
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

      return created.event.cardId
    },
  })
  const unoffer = offerHost({
    hydraId,
    ask: ({ body }) => hostRequest({
      host,
      body,
    }),
  })
  const grant = async ({ revoke = false }: { revoke?: boolean }) => runForClient({
    identity: { PNYX_ACTOR: 'hydra' },
    cwd: process.env.HOME!,
    run: () => commands.task([
      'tools',
      task,
      revoke ? '--revoke' : '--grant',
      'mcp:unrelated.server',
      revoke ? '--revoke' : '--grant',
      'plugin:company@fixture',
      revoke ? '--revoke' : '--grant',
      'browser',
      '--actor',
      'hydra',
      '--hydra',
      hydraId,
    ]),
  })

  const releaseHold = () => {
    withWriter({
      hydraId,
      fn: ({ writer }) => {
        const card = writer.state.cards[task]!
        const released = hydraEvent({
          state: writer.state,
          cardId: task,
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
          change: {
            type: 'task.released',
            data: {
              hold: card.hold!.id,
              message: {
                id: 'fixture-go',
                text: 'Go',
                at: new Date().toISOString(),
              },
            },
          },
        })
        assert.ok('event' in released)
        writer.append({ event: released.event })
      },
    })
    host.reconcile({ state: loadHydra({ hydraId }).state })
  }

  const count = () => harness === 'claude' ? claude.length : native.sessions.length
  const incoming = ({ index }: { index: number }) => harness === 'claude' ? claude[index]?.incoming.length : native.sessions[index]?.received.length

  try {
    host.send({
      card: task,
      text: 'Work',
      actor: 'cli',
      direct: true,
      inputId: 'first',
    })
    await settle({
      what: 'first input',
      check: () => incoming({ index: 0 }) === 1,
    })

    const initialEnv = harness === 'claude' ? claude[0]!.options()?.env : native.sessions[0]!.env
    assert.ok(initialEnv)
    assert.deepEqual(
      Object.keys(initialEnv).filter(name => name.startsWith('CHROME_DEVTOOLS_AXI_')),
      [],
    )
    assert.equal(
      initialEnv.PNYX_HYDRA,
      hydraId,
    )

    if (harness === 'codex') {
      assert.deepEqual(
        Object.keys(native.sessions[0]!.config ?? {}).filter(name => name.startsWith('shell_environment_policy.set.CHROME_DEVTOOLS_AXI_')),
        [],
      )
    }

    if (harness === 'claude') {
      assert.equal(
        claude[0]!.options()?.strictMcpConfig,
        true,
      )
      assert.deepEqual(
        claude[0]!.options()?.mcpServers,
        {},
      )
      assert.deepEqual(
        claude[0]!.options()?.settings,
        {
          enabledPlugins: {
            'unused@fixture': false,
            'company@fixture': false,
          },
        },
      )
    } else {
      assert.equal(
        native.sessions[0]!.config?.['mcp_servers."unrelated.server".enabled'],
        false,
      )
      assert.equal(
        native.sessions[0]!.config?.['features.plugins'],
        false,
      )
    }

    await assert.rejects(
      runForClient({
        identity: { PNYX_ACTOR: 'hydra' },
        cwd: process.env.HOME!,
        run: () => commands.task([
          'tools',
          task,
          '--grant',
          'mcp:unrelated.server',
          '--harness',
          harness === 'claude' ? 'codex' : 'claude',
          '--actor',
          'hydra',
          '--hydra',
          hydraId,
        ]),
      }),
      { code: 'VALIDATION_ERROR' },
    )
    assert.deepEqual(
      loadHydra({ hydraId }).state.cards[task]?.tools,
      undefined,
    )
    await grant({})
    assert.equal(
      count(),
      1,
      'a grant must wait for the foreground turn',
    )
    await runForClient({
      identity: { PNYX_ACTOR: 'hydra' },
      cwd: process.env.HOME!,
      run: () => commands.task([
        'hold',
        task,
        '--reason',
        'Hold scheduled grant',
        '--actor',
        'hydra',
        '--hydra',
        hydraId,
      ]),
    })

    if (harness === 'claude') {
      claude[0]!.send({
        message: {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [
            {
              task_id: 'held',
              task_type: 'shell',
              description: 'Held work',
            },
          ],
          uuid: randomUUID(),
          session_id: sessionId,
        },
      })
      claude[0]!.send({
        message: {
          ...result,
          uuid: randomUUID(),
          user_message_uuid: claude[0]!.incoming[0]!.uuid,
          queued_turn_count: 0,
        },
      })
    } else {
      native.sessions[0]!.notify!({
        method: 'item/completed',
        params: {
          item: {
            id: 'held',
            type: 'commandExecution',
            status: 'inProgress',
            processId: 'held-process',
            exitCode: null,
          },
        },
      })
      first.release()
    }

    await settle({
      what: 'foreground ends while background work remains',
      check: () => loadHydra({ hydraId }).state.cards[task]?.sessionActivity === 'finished',
    })
    assert.equal(
      count(),
      1,
      'a grant must also wait for background work',
    )
    const original = host.diagnostics().sessions.find(session => session.taskId === task)
    assert.equal(
      original?.sessionId,
      `${harness === 'claude' ? 'claude-code' : 'codex'}:${sessionId}`,
    )
    assert.equal(
      original?.attached,
      true,
    )
    assert.equal(
      original?.work?.background.knowledge,
      'known',
    )
    assert.ok(original?.work?.background.knowledge === 'known' && original.work.background.tasks.length > 0)

    if (harness === 'claude') {
      claude[0]!.send({
        message: {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [],
          uuid: randomUUID(),
          session_id: sessionId,
        },
      })
    } else {
      native.sessions[0]!.notify!({
        method: 'item/completed',
        params: {
          item: {
            id: 'held',
            type: 'commandExecution',
            status: 'completed',
            exitCode: 0,
          },
        },
      })
    }

    await settle({
      what: 'scheduled grant stays deferred under the hold',
      check: () => host.diagnostics().sessions.length === 0,
    })
    releaseHold()
    await settle({
      what: 'grant resumes the same conversation',
      check: () => count() === 2 && incoming({ index: 1 }) === 1,
    })
    assert.equal(
      loadHydra({ hydraId }).state.cards[task]?.agent?.sessionId,
      sessionId,
    )

    await grant({ revoke: true })
    releaseCopyLease = taskLease({
      hydraId,
      task,
      actor: `${COPY_LEASE_PREFIX}${randomUUID()}`,
    })

    if (harness === 'claude') {
      assert.equal(
        claude[1]!.options()?.resume,
        sessionId,
      )
      assert.equal(
        claude[1]!.options()?.env?.CHROME_DEVTOOLS_AXI_SESSION,
        `pnyx-${hydraId}-${task}`,
      )
      assert.equal(
        claude[1]!.options()?.env?.CHROME_DEVTOOLS_AXI_HEADED,
        '0',
      )
      assert.deepEqual(
        claude[1]!.options()?.mcpServers,
        {
          'unrelated.server': { command: 'synthetic-mcp' },
          plugin_company_bundled: { command: `${plugin}/server` },
        },
      )
      assert.deepEqual(
        claude[1]!.options()?.plugins,
        [
          {
            type: 'local',
            path: plugin,
            skipMcpDiscovery: true,
          },
        ],
      )
      claude[1]!.send({
        message: {
          ...result,
          uuid: randomUUID(),
          user_message_uuid: claude[1]!.incoming[0]!.uuid,
          queued_turn_count: 0,
        },
      })
      await settle({
        what: 'grant turn finishes',
        check: () => claude[1]!.delivered() === 1,
      })
    } else {
      assert.equal(
        native.sessions[1]!.config?.['mcp_servers."unrelated.server".enabled'],
        true,
      )
      assert.equal(
        native.sessions[1]!.config?.['shell_environment_policy.set.CHROME_DEVTOOLS_AXI_SESSION'],
        `pnyx-${hydraId}-${task}`,
      )
      assert.equal(
        native.sessions[1]!.config?.['plugins."company@fixture".mcp_servers."bundled".enabled'],
        true,
      )
      assert.equal(
        native.sessions[1]!.config?.['plugins."unused@fixture".mcp_servers."unused".enabled'],
        false,
      )
      grantTurn.release()
      await settle({
        what: 'grant turn finishes',
        check: () => loadHydra({ hydraId }).state.cards[task]?.sessionActivity === 'finished',
      })
    }

    await settle({
      what: 'scheduled revocation waits for copy settlement',
      check: () => host.diagnostics().sessions.length === 0,
    })
    assert.equal(
      count(),
      2,
      'a scheduled revocation cannot resume during copy settlement',
    )
    releaseCopyLease()
    releaseCopyLease = undefined
    host.reconcile({ state: loadHydra({ hydraId }).state })
    await settle({
      what: 'revocation resumes without the server',
      check: () => count() === 3 && incoming({ index: 2 }) === 1,
    })

    if (harness === 'claude') {
      assert.deepEqual(
        claude[2]!.options()?.mcpServers,
        {},
      )
    } else {
      assert.equal(
        native.sessions[2]!.config?.['mcp_servers."unrelated.server".enabled'],
        false,
      )
    }

    if (harness === 'claude') {
      claude[2]!.send({
        message: {
          ...result,
          uuid: randomUUID(),
          user_message_uuid: claude[2]!.incoming[0]!.uuid,
          queued_turn_count: 0,
        },
      })
    }

    await settle({
      what: 'revoked worker idle before restart',
      check: () => loadHydra({ hydraId }).state.cards[task]?.sessionActivity === 'finished',
    })
    runForClient({
      identity: { PNYX_ACTOR: 'hydra' },
      cwd: process.env.HOME!,
      run: () => recordTools({
        hydraId,
        task,
        grant: [
          'browser',
          'mcp:unrelated.server',
          'plugin:company@fixture',
        ],
        meta: {
          actor: 'hydra',
          at: new Date().toISOString(),
        },
      }),
    })
    const pending = loadHydra({ hydraId }).state.cards[task]!
    assert.notEqual(
      pending.toolsApplied,
      pending.toolsRevision,
    )
    await runForClient({
      identity: { PNYX_ACTOR: 'hydra' },
      cwd: process.env.HOME!,
      run: () => commands.task([
        'hold',
        task,
        '--reason',
        'Fixture hold',
        '--actor',
        'hydra',
        '--hydra',
        hydraId,
      ]),
    })
    await assert.rejects(
      grant({}),
      { code: 'TASK_HELD' },
    )
    recoveredTurn = native.plan({
      hold: true,
    })
    host.close()
    host = createHost({
      hydraId,
      query,
      spawnCodex: native.spawnCodex,
      changed: () => {},
      wakeDelay: 3_600_000,
    })
    await host.recover()
    assert.equal(
      host.diagnostics().sessions.length,
      0,
      'a pending grant must not resume a held task',
    )
    releaseCopyLease = taskLease({
      hydraId,
      task,
      actor: `${COPY_LEASE_PREFIX}${randomUUID()}`,
    })
    releaseHold()
    assert.equal(
      count(),
      3,
      'a recovered grant cannot open a session during copy settlement',
    )
    releaseCopyLease()
    releaseCopyLease = undefined
    host.reconcile({ state: loadHydra({ hydraId }).state })
    await settle({
      what: 'pending grant resumes after restart',
      check: () => count() === 4 && incoming({ index: 3 }) === 1,
    })
    assert.equal(
      loadHydra({ hydraId }).state.cards[task]?.agent?.sessionId,
      sessionId,
    )
    await settle({
      what: 'grant application is durably confirmed',
      check: () => {
        const card = loadHydra({ hydraId }).state.cards[task]!

        return card.toolsApplied === card.toolsRevision
      },
    })

    await grant({ revoke: true })
    releaseCopyLease = taskLease({
      hydraId,
      task,
      actor: `${COPY_LEASE_PREFIX}${randomUUID()}`,
    })
    assert.deepEqual(
      await host.release({
        task,
        permanent: true,
      }),
      { released: 1 },
    )
    assert.equal(
      count(),
      4,
      'permanent release does not reopen a worker during copy settlement',
    )
    releaseCopyLease()
    releaseCopyLease = undefined
    host.reconcile({ state: loadHydra({ hydraId }).state })
    await settle({
      what: 'permanently retired tool revision retries in its available folder',
      check: () => count() === 5 && incoming({ index: 4 }) === 1,
    })
    assert.equal(
      loadHydra({ hydraId }).state.cards[task]?.agent?.sessionId,
      sessionId,
    )

    const unavailable = withWriter({
      hydraId,
      fn: ({ writer }) => {
        const created = planTaskChange({
          hydraId,
          state: writer.state,
          landing: new Map(),
          operation: {
            op: 'task.create',
            key: 'missing-tool',
            title: 'Missing tool',
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
    await assert.rejects(
      runForClient({
        identity: { PNYX_ACTOR: 'hydra' },
        cwd: process.env.HOME!,
        run: () => commands.task([
          'start',
          unavailable,
          '--harness',
          harness,
          '--tool',
          'mcp:missing',
          '--folder',
          process.env.HOME!,
          '--actor',
          'hydra',
          '--reason',
          'Fixture dispatch',
          '--hydra',
          hydraId,
        ]),
      }),
      { code: 'TOOL_UNAVAILABLE' },
    )
    assert.equal(
      loadHydra({ hydraId }).state.cards[unavailable]?.tools,
      undefined,
    )
  } finally {
    releaseCopyLease?.()
    recoveredTurn?.release()
    grantTurn.release()
    first.release()
    host.close()
    unoffer()
  }
}

console.log('Tool grants and revocations resume Claude and Codex at safe turn boundaries')

const summaryHydra = 'summary-tools'
await commands.hydra([
  'create',
  summaryHydra,
])
const summaries: ReturnType<typeof claudeNative>[] = []
const summaryHost = createHost({
  hydraId: summaryHydra,
  query: ({
    prompt,
    options,
  }) => {
    const native = claudeNative()

    if (options?.persistSession !== false) {
      summaries.push(native)
    }

    return native.query({
      prompt,
      options,
    })
  },
  changed: () => {},
  wakeDelay: 3_600_000,
})

try {
  await summaryHost.hydra({
    id: 'initial',
    text: 'Begin',
    actor: 'cli',
  })
  await settle({
    what: 'Hydra initial input',
    check: () => summaries[0]?.incoming.length === 1,
  })
  summaries[0]!.send({
    message: {
      ...result,
      uuid: randomUUID(),
      user_message_uuid: summaries[0]!.incoming[0]!.uuid,
      queued_turn_count: 0,
    },
  })
  await settle({
    what: 'Hydra first turn finishes',
    check: () => loadHydra({ hydraId: summaryHydra }).state.cards.$hydra?.sessionActivity === 'finished',
  })
  runForClient({
    identity: { PNYX_ACTOR: 'hydra' },
    cwd: process.env.HOME!,
    run: () => recordTools({
      hydraId: summaryHydra,
      task: '$hydra',
      grant: ['mcp:unrelated.server'],
      meta: {
        actor: 'hydra',
        at: new Date().toISOString(),
      },
    }),
  })
  await summaryHost.hydra({
    id: 'switch',
    text: 'Switch model',
    actor: 'cli',
    selected: {
      harness: 'claude',
      account: 'claude:test',
      model: 'opus',
    },
  })
  summaryHost.changeAgent({
    id: 'switch',
    choice: 'compact',
  })
  await settle({
    what: 'handoff summary',
    check: () => summaries[1]?.incoming.length === 1,
  })
  assert.deepEqual(
    summaries[1]!.options()?.mcpServers,
    {},
    'summaries must not inherit Hydra grants',
  )
  assert.deepEqual(
    summaries[1]!.options()?.plugins,
    [],
  )
  assert.doesNotMatch(
    JSON.stringify(summaries[1]!.options()?.systemPrompt),
    /ask Hydra with pnyx-axi task ask/,
    'a summary gets no worker instructions',
  )
  summaries[1]!.send({
    message: {
      ...result,
      uuid: randomUUID(),
      user_message_uuid: summaries[1]!.incoming[0]!.uuid,
      queued_turn_count: 0,
    },
  })
  await settle({
    what: 'handoff completed',
    check: () => !loadHydra({ hydraId: summaryHydra }).state.hydraAgentChange,
  })
} finally {
  summaryHost.close()
}

console.log('Handoff summaries keep an empty tool set when Hydra has grants')

const ownHydra = 'hydra-tools'
await commands.hydra([
  'create',
  ownHydra,
])
const hydraSessions: ReturnType<typeof claudeNative>[] = []

const hydraQuery: QueryFn = ({
  prompt,
  options,
}) => {
  const native = claudeNative()

  if (options?.persistSession !== false) {
    hydraSessions.push(native)
  }

  return native.query({
    prompt,
    options,
  })
}

let hydraHost = createHost({
  hydraId: ownHydra,
  query: hydraQuery,
  changed: () => {},
  wakeDelay: 3_600_000,
})
const hydraCard = () => loadHydra({ hydraId: ownHydra }).state.cards.$hydra!
const unofferHydra = offerHost({
  hydraId: ownHydra,
  ask: ({ body }) => hostRequest({
    host: hydraHost,
    body,
  }),
})

const finishTurn = async ({ index }: { index: number }) => {
  const session = hydraSessions[index]!
  session.send({
    message: {
      ...result,
      uuid: randomUUID(),
      user_message_uuid: session.incoming.at(-1)!.uuid,
      queued_turn_count: 0,
    },
  })
  await settle({
    what: `Hydra turn ${index} finishes`,
    check: () => hydraCard().sessionActivity === 'finished',
  })
}

try {
  await hydraHost.hydra({
    id: 'initial',
    text: 'Begin',
    actor: 'cli',
  })
  await settle({
    what: 'Hydra initial input',
    check: () => hydraSessions[0]?.incoming.length === 1,
  })
  await finishTurn({ index: 0 })
  const conversation = hydraCard().agent!.sessionId
  await runForClient({
    identity: { PNYX_ACTOR: 'hydra' },
    cwd: process.env.HOME!,
    run: () => commands.task([
      'tools',
      '$hydra',
      '--grant',
      'browser',
      '--actor',
      'hydra',
      '--hydra',
      ownHydra,
    ]),
  })
  await settle({
    what: 'Hydra resumes with its own grant',
    check: () => hydraSessions[1]?.incoming.length === 1,
  })
  assert.equal(
    hydraSessions[1]!.options()?.resume,
    conversation,
  )
  assert.equal(
    hydraSessions[1]!.options()?.env?.CHROME_DEVTOOLS_AXI_SESSION,
    `pnyx-${ownHydra}-hydra`,
  )
  const prompt = JSON.stringify(hydraSessions[1]!.options()?.systemPrompt)
  assert.match(
    prompt,
    /Pnyx external tool grants: browser\./,
  )
  assert.doesNotMatch(
    prompt,
    /ask Hydra with pnyx-axi task ask/,
    'Hydra is not told to ask itself for tools',
  )
  await settle({
    what: 'Hydra grant applied',
    check: () => hydraCard().toolsApplied === hydraCard().toolsRevision,
  })
  await finishTurn({ index: 1 })
  recordTools({
    hydraId: ownHydra,
    task: '$hydra',
    revoke: ['browser'],
    meta: {
      actor: 'hydra',
      at: new Date().toISOString(),
    },
  })
  hydraHost.close()
  hydraHost = createHost({
    hydraId: ownHydra,
    query: hydraQuery,
    changed: () => {},
    wakeDelay: 3_600_000,
  })
  await hydraHost.recover()
  await settle({
    what: 'a pending Hydra grant applies after restart',
    check: () => hydraSessions[2]?.incoming.length === 1,
  })
  assert.equal(
    hydraSessions[2]!.options()?.resume,
    conversation,
  )
  assert.equal(
    hydraSessions[2]!.options()?.env?.CHROME_DEVTOOLS_AXI_SESSION,
    undefined,
  )
  await settle({
    what: 'recovered Hydra grant applied',
    check: () => hydraCard().toolsApplied === hydraCard().toolsRevision,
  })
} finally {
  hydraHost.close()
  unofferHydra()
}

console.log('Hydra applies grants to its own card in the same conversation, including after restart')
