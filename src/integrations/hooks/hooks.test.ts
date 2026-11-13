import { closeLogs, flushLogs, logsDir, openLogs } from '#app/diagnostics.ts'
import { query } from '#store/postgres.ts'
// Hook payload normalization and spool ingestion. Every path lives in a temporary
// folder: tests never read or edit the real ~/.claude, ~/.codex or ~/.pnyx.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Attention } from '#workers/model.ts'
import { drainSpool, ingestSpool } from './ingest.ts'
import { PR_COMMANDS, attend, observe, type HookEnvelope } from './observe.ts'
import { readEvents } from '#app/event-log.ts'
import { spoolWrite } from '#app/spool.ts'
import { spoolFiles } from '#store/storage.ts'
import { loadHydra, reloadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { runForRequest } from '#app/api-run.ts'
import { decidePush } from '#tasks/push.ts'
import { applyDecision } from '#app/decision.ts'
import { harvestTranscripts } from './harvest.ts'

const ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
)
const SCRIPT = join(
  ROOT,
  'setup',
  'hooks',
  'pnyx-hook.sh',
)
const FIXTURES = join(
  import.meta.dirname,
  'fixtures',
)
const ECHO_CLI = join(
  FIXTURES,
  'echo-cli.mjs',
)

const fixture = ({ name }: { name: string }) => readFileSync(
  join(
    FIXTURES,
    `${name}.json`,
  ),
  'utf8',
)
const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Elicitation',
  'ElicitationResult',
  'SubagentStart',
  'SubagentStop',
  'PostCompact',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'PostModelSwitch',
]
const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'PostCompact',
  'Stop',
  'Interrupt',
  'SessionEnd',
]

function sandbox() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-h-',
  ))
  const home = join(
    root,
    '.pnyx',
  )
  const spool = join(
    home,
    'hydras',
    'default',
    'spool',
  )

  return {
    home,
    spool,
  }
}

test(
  'spool ingestion keeps write order across a wrapped hook PID',
  () => {
    const {
      home,
      spool,
    } = sandbox()
    mkdirSync(
      spool,
      { recursive: true },
    )
    const hooks = [
      {
        pid: '0000099999',
        event: 'PreToolUse',
      },
      {
        pid: '0000000001',
        event: 'PermissionRequest',
      },
      {
        pid: '0000000002',
        event: 'PostToolUse',
      },
    ]

    for (const [
      index,
      hook,
    ] of hooks.entries()) {
      const file = join(
        spool,
        `001793038000000-${hook.pid}-hook.json`,
      )
      writeFileSync(
        file,
        JSON.stringify({ event: hook.event }),
      )
      const at = new Date(1_793_038_000_000 + index * 20)
      utimesSync(
        file,
        at,
        at,
      )
    }

    const ordered = spoolFiles({
      dir: join(
        home,
        'hydras',
        'default',
      ),
    })
      .map(file => JSON.parse(readFileSync(
        file,
        'utf8',
      )).event)
    assert.deepEqual(
      ordered,
      hooks.map(hook => hook.event),
    )
  },
)

const envelope = ({
  harness,
  event,
  name,
}: {
  harness: 'claude' | 'codex'
  event: string
  name: string
}): HookEnvelope => ({
  v: 1,
  id: 'hook-1-1',
  at: '2026-10-13T14:00:00Z',
  harness,
  event,
  payload: JSON.parse(fixture({ name })),
})

test(
  'a created pull request is a link only when a PR command is in command position',
  () => {
    const [created] = observe({
      envelope: envelope({
        harness: 'claude',
        event: 'PostToolUse',
        name: 'claude-post-tool-pr-create',
      }),
    })
    assert.equal(
      created!.card.activity,
      'working',
    )
    assert.equal(
      created!.link,
      'https://github.com/example/repo/pull/42',
    )
    assert.equal(
      observe({
        envelope: envelope({
          harness: 'codex',
          event: 'PostToolUse',
          name: 'codex-post-tool-deploy',
        }),
      })[0]!.link,
      undefined,
    )
    const created42 = JSON.parse(fixture({ name: 'claude-post-tool-pr-create' })) as Record<string, unknown>
    const link = ({ command }: { command: unknown }) =>
      observe({
        envelope: {
          ...envelope({
            harness: 'claude',
            event: 'PostToolUse',
            name: 'claude-post-tool-pr-create',
          }),
          payload: {
            ...created42,
            tool_input: { command },
          },
        },
      })[0]!.link

    for (const command of [
      'echo gh pr create',
      'cat gh-pr-create.md',
      [
        'bash',
        '-lc',
        'cat notes.md',
      ],
    ]) {
      assert.equal(
        link({ command }),
        undefined,
        String(command),
      )
    }

    for (const command of [
      ...PR_COMMANDS,
      'git push && gh pr create --fill',
      [
        'bash',
        '-lc',
        'gh-axi pr create --title x',
      ],
    ]) {
      assert.equal(
        link({ command }),
        'https://github.com/example/repo/pull/42',
        String(command),
      )
    }
  },
)

const ask: Attention = {
  kind: 'question',
  key: 'hook:tool:AskUserQuestion',
  blocking: true,
  text: 'Do you prefer red or blue?',
  questions: [
    {
      question: 'Do you prefer red or blue?',
      header: 'Color',
      options: [
        {
          label: 'Red',
          description: 'Choose red',
        },
        {
          label: 'Blue',
          description: 'Choose blue',
        },
      ],
    },
  ],
}
const allowTouch = ({ tool }: { tool: string }): Attention =>
  ({
    kind: 'permission',
    key: `hook:tool:${tool}`,
    blocking: true,
    text: `Allow ${tool}: touch hello.txt && echo made`,
  })
// Requests an event shows, by the name a CASES row gives them.
const REQUESTS: Record<string, Attention[]> = {
  ask: [ask],
  bash: [allowTouch({ tool: 'Bash' })],
  plan: [
    {
      kind: 'plan',
      key: 'hook:tool:ExitPlanMode',
      blocking: true,
      text: 'Approve the plan',
    },
  ],
  write: [
    {
      kind: 'permission',
      key: 'hook:tool:Write',
      blocking: true,
      text: 'Allow Write: /work/repo/notes.md',
    },
  ],
  permission: [
    {
      kind: 'permission',
      key: 'hook:notification',
      blocking: true,
      text: 'Claude needs your permission',
    },
  ],
  input: [
    {
      kind: 'input',
      key: 'hook:notification',
      blocking: true,
      text: 'A background agent needs your input',
    },
  ],
  elicitation: [
    {
      kind: 'input',
      key: 'hook:elicitation',
      blocking: true,
      text: 'An MCP server is asking for input',
    },
  ],
  form: [
    {
      kind: 'input',
      key: 'hook:elicitation',
      blocking: true,
      text: 'my-mcp-server: Please provide your username',
      form: [
        {
          name: 'username',
          title: 'Username',
          type: 'string',
        },
      ],
    },
  ],
}
// One row per fixture: harness, event, fixture, the turn state it sets ('-' leaves it, 'none' means
// the event maps to nothing) and its requests ('clears' ends hook requests, 'keeps' leaves them, or a REQUESTS name).
const CASES = [
  'claude SessionStart claude-session-start finished clears',
  'claude SessionStart claude-session-start-compact - clears',
  'claude UserPromptSubmit claude-user-prompt working clears',
  'claude PreToolUse claude-pre-tool-ls working clears',
  'claude PreToolUse claude-pre-tool-ask working ask',
  'claude PermissionRequest claude-permission-request - bash',
  'claude PermissionRequest claude-permission-request-ask - ask',
  'claude PermissionRequest claude-permission-request-plan - plan',
  'claude PermissionRequest claude-permission-request-subagent - write',
  'claude PermissionDenied claude-permission-denied - clears',
  'claude PostToolUse claude-post-tool-bash working clears',
  'claude PostToolUseFailure claude-post-tool-failure working clears',
  'claude Notification claude-notification-permission - permission',
  'claude Notification claude-notification-idle finished keeps',
  'claude Notification claude-notification-input - input',
  'claude Notification claude-notification-elicitation - elicitation',
  'claude Notification claude-notification-elicitation-done - clears',
  'claude Notification claude-notification-quota none',
  'claude Notification claude-notification-auth none',
  'claude Elicitation claude-elicitation - form',
  'claude ElicitationResult claude-elicitation-result - clears',
  'claude SubagentStart claude-subagent-start working keeps',
  'claude SubagentStop claude-subagent-stop finished clears',
  'claude SubagentStop claude-subagent-stop-helper none',
  'claude PostCompact claude-post-compact - keeps',
  'claude Stop claude-stop finished clears',
  'claude StopFailure claude-stop-failure finished clears',
  'claude SessionEnd claude-session-end ended clears',
  'claude PostModelSwitch claude-post-model-switch - keeps',
  'codex SessionStart codex-session-start finished clears',
  'codex UserPromptSubmit codex-user-prompt working clears',
  'codex PreToolUse codex-pre-tool working clears',
  'codex PermissionRequest codex-permission-request - bash',
  'codex PostToolUse codex-post-tool working clears',
  'codex SubagentStart codex-subagent-start working keeps',
  'codex SubagentStop codex-subagent-stop finished clears',
  'codex PostCompact codex-post-compact - keeps',
  'codex Stop codex-stop finished clears',
  'codex Interrupt codex-interrupt finished clears',
  'codex SessionEnd codex-session-end ended clears',
]

test(
  'every subscribed event of both harnesses maps to its turn state and the requests its interface shows',
  () => {
    for (const row of CASES) {
      const [
        harness,
        event,
        name,
        activity,
        requests,
      ] = row.split(' ') as ['claude' | 'codex', string, string, string, string]
      assert.ok(
        activity === 'none' || requests === 'keeps' || requests === 'clears' || requests in REQUESTS,
        `unknown requests token in: ${row}`,
      )
      const observations = observe({
        envelope: envelope({
          harness,
          event,
          name,
        }),
      })

      if (activity === 'none') {
        assert.deepEqual(
          observations,
          [],
          name,
        )
        continue
      }

      const o = observations.at(-1)!
      assert.equal(
        o.card.activity,
        activity === '-' ? undefined : activity,
        name,
      )
      assert.deepEqual(
        o.attend ? attend({
          current: [],
          change: o.attend,
        }) : undefined,
        requests === 'keeps' ? undefined : requests === 'clears' ? [] : REQUESTS[requests],
        name,
      )
    }

    for (const [
      harness,
      events,
    ] of [
        [
          'claude',
          CLAUDE_EVENTS,
        ],
        [
          'codex',
          CODEX_EVENTS,
        ],
      ] as const) {
      const covered = new Set(CASES.filter(c => c.startsWith(`${harness} `)).map(c => c.split(' ')[1]))
      assert.deepEqual(
        covered,
        new Set(events),
        harness,
      )
    }
  },
)

test(
  'a request ends with its own tool call, the turn, or a newer request, and only hook requests are cleared',
  () => {
    const change = ({
      event,
      name,
    }: {
      event: string
      name: string
    }) => observe({
      envelope: envelope({
        harness: 'claude',
        event,
        name,
      }),
    }).at(-1)!.attend!
    const decision: Attention = {
      kind: 'decision',
      key: 'firstmate:api-shape',
      blocking: true,
    }
    const write: Attention = {
      kind: 'permission',
      key: 'hook:tool:Write',
      blocking: true,
      text: 'Allow Write',
    }
    const note: Attention = {
      kind: 'check',
      key: 'firstmate:note',
      blocking: false,
    }

    assert.deepEqual(
      attend({
        current: [
          allowTouch({ tool: 'Bash' }),
          write,
        ],
        change: change({
          event: 'PostToolUse',
          name: 'claude-post-tool-bash',
        }),
      }),
      [write],
    )
    assert.deepEqual(
      attend({
        current: [write],
        change: change({
          event: 'Notification',
          name: 'claude-notification-permission',
        }),
      }),
      [write],
    )
    assert.deepEqual(
      attend({
        current: [note],
        change: change({
          event: 'PermissionRequest',
          name: 'claude-permission-request',
        }),
      }),
      [
        allowTouch({ tool: 'Bash' }),
        note,
      ],
    )
    assert.deepEqual(
      attend({
        current: [
          decision,
          write,
        ],
        change: change({
          event: 'Stop',
          name: 'claude-stop',
        }),
      }),
      [decision],
    )
    assert.deepEqual(
      attend({
        current: [ask],
        change: change({
          event: 'UserPromptSubmit',
          name: 'claude-user-prompt',
        }),
      }),
      [],
    )
    assert.deepEqual(
      attend({
        current: [ask],
        change: change({
          event: 'PostToolUse',
          name: 'claude-post-tool-bash',
        }),
      }),
      [ask],
    )
  },
)

// Spools one hook event into the sandbox's default Hydra and ingests it in process, as the next write would.

test(
  'a hook event ingested twice, from the socket and the spool, is applied once',
  () => {
    process.env.PNYX_HOME = sandbox().home
    const line = {
      ...envelope({
        harness: 'claude',
        event: 'SubagentStart',
        name: 'claude-subagent-start',
      }),
      id: 'hook-9-9',
    }
    spoolWrite({
      hydraId: 'default',
      entry: line,
    })
    spoolWrite({
      hydraId: 'default',
      entry: line,
    })
    ingestSpool({ hydraId: 'default' })
    assert.equal(
      readEvents({ hydraId: 'default' }).length,
      2,
      'parent and child, once each',
    )
  },
)

test(
  'a command that fails after taking the spool leaves its events for the next write',
  () => {
    const { home } = sandbox()
    process.env.PNYX_HOME = home
    spoolWrite({
      hydraId: 'default',
      entry: {
        ...envelope({
          harness: 'claude',
          event: 'SubagentStart',
          name: 'claude-subagent-start',
        }),
        id: 'hook-7-7',
      },
    })
    assert.throws(
      () => withWriter({
        hydraId: 'default',
        create: true,
        fn: ({ writer }) => {
          drainSpool({ writer })
          throw new Error('refused after the spool')
        },
      }),
      /refused after the spool/,
    )
    assert.equal(
      spoolFiles({
        dir: join(
          home,
          'hydras',
          'default',
        ),
      }).length,
      1,
    )
    ingestSpool({ hydraId: 'default' })
    assert.ok(readEvents({ hydraId: 'default' }).some(event => event.id === 'hook-7-7'))
  },
)

const NUL_SESSION = 'aaaaaaaa-0000-4000-8000-000000000001'
const EMOJI_SESSION = 'aaaaaaaa-0000-4000-8000-000000000002'

const promptHook = ({
  id,
  session,
  prompt,
}: {
  id: string
  session: string
  prompt: string
}) => spoolWrite({
  hydraId: 'default',
  entry: {
    v: 1,
    id,
    at: '2026-11-13T09:00:00.000Z',
    harness: 'claude',
    event: 'UserPromptSubmit',
    payload: {
      session_id: session,
      transcript_path: `/work/home/.claude/projects/-work-repo/${session}.jsonl`,
      cwd: '/work/repo',
      permission_mode: 'default',
      hook_event_name: 'UserPromptSubmit',
      prompt,
    },
  },
})

test(
  'a hook prompt holding a NUL, a lone surrogate or an emoji at the title cut is stored, and later writes still succeed',
  async () => {
    const { home } = sandbox()
    process.env.PNYX_HOME = home
    promptHook({
      id: 'hook-nul',
      session: NUL_SESSION,
      prompt: 'Fix the\u0000 build \ud83d now',
    })
    promptHook({
      id: 'hook-emoji',
      session: EMOJI_SESSION,
      prompt: `${'a'.repeat(98)}😀 and more`,
    })
    ingestSpool({ hydraId: 'default' })
    assert.deepEqual(
      readdirSync(join(
        home,
        'hydras',
        'default',
        'spool',
      )),
      [],
      'both events left the spool, none set aside',
    )

    const titleOf = ({ session }: { session: string }) => Object.values(loadHydra({ hydraId: 'default' }).state.cards)
      .find(card => card.agent?.sessionId === session)?.title
    assert.equal(
      titleOf({ session: NUL_SESSION }),
      'Fix the� build � now',
    )
    assert.equal(
      titleOf({ session: EMOJI_SESSION }),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa😀…',
    )

    const created = await runForRequest({
      body: {
        argv: [
          'task',
          'create',
          '--title',
          'After the odd prompts',
          '--key',
          'after-odd-prompts',
        ],
        cwd: '/work/repo',
        env: {},
      },
    })
    assert.equal(
      created.exitCode,
      0,
      created.stdout,
    )

    const inMemory = JSON.parse(JSON.stringify(loadHydra({ hydraId: 'default' }).state))
    reloadHydra({ hydraId: 'default' })
    assert.deepEqual(
      JSON.parse(JSON.stringify(loadHydra({ hydraId: 'default' }).state)),
      inMemory,
      'the Hydra read back from its rows equals the one in memory',
    )
  },
)

function scriptSandbox() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-h-',
  ))
  const home = join(
    root,
    '.pnyx',
  )
  const env = {
    ...process.env,
    HOME: root,
    PNYX_HOME: home,
    CLAUDE_CONFIG_DIR: join(
      root,
      'claude',
    ),
    CODEX_HOME: join(
      root,
      'codex',
    ),
  }

  const run = async ({ args }: { args: string[] }) => {
    const result = await runForRequest({
      body: {
        argv: args,
        cwd: root,
        env: {},
      },
    })
    assert.equal(
      result.exitCode,
      0,
      result.stdout,
    )

    return result.stdout
  }

  const script = join(
    home,
    'hooks',
    'pnyx-hook.sh',
  )
  mkdirSync(
    join(
      home,
      'hooks',
    ),
    { recursive: true },
  )
  copyFileSync(
    SCRIPT,
    script,
  )

  return {
    root,
    env,
    run,
    script,
  }
}

test(
  'SessionStart prints the open tasks of the attached project holding the folder, and nothing elsewhere',
  async t => {
    const {
      root,
      env,
      run,
      script,
    } = scriptSandbox()
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = env.PNYX_HOME
    t.after(() => {
      process.env.PNYX_HOME = previous
    })
    const project = join(
      root,
      'shop',
    )
    const nested = join(
      project,
      'src',
    )
    mkdirSync(
      nested,
      { recursive: true },
    )
    await run({
      args: [
        'project',
        'add',
        project,
      ],
    })
    await run({
      args: [
        'task',
        'create',
        '--title',
        'Fix the cart total',
        '--project',
        'shop',
      ],
    })
    const context = ({ cwd }: { cwd: string }) => run({
      args: [
        'context',
        '--cwd',
        cwd,
      ],
    })
    const hook = ({
      event,
      cwd,
      payload,
      extra = {},
    }: {
      event: string
      cwd: string
      payload: Record<string, string>
      extra?: Record<string, string>
    }) => execFileSync(
      '/bin/sh',
      [
        script,
        'claude',
        event,
        ECHO_CLI,
      ],
      {
        cwd,
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: {
          ...env,
          ...extra,
        },
      },
    )
    let sessions = 0
    const start = ({
      cwd,
      extra,
    }: {
      cwd: string
      extra?: Record<string, string>
    }) => hook({
      event: 'SessionStart',
      cwd,
      payload: {
        session_id: `s${++sessions}`,
        cwd,
      },
      extra,
    })

    assert.match(
      start({ cwd: nested }),
      /^context --hydra default --cwd \S*\/shop\/src\n$/,
      'SessionStart asks the CLI for the summary of its folder',
    )
    const summary = await context({ cwd: nested })
    assert.match(
      summary,
      /project shop/,
    )
    assert.match(
      summary,
      /Fix the cart total,queued/,
    )
    start({ cwd: root })
    assert.equal(
      (await context({ cwd: root })).trim(),
      '',
      'a folder outside every attached project gets no summary',
    )
    assert.equal(
      start({
        cwd: nested,
        extra: { PNYX_TASK: 'task-1' },
      }),
      '',
      'a worker session gets its context from Pnyx instead',
    )
    assert.equal(
      hook({
        event: 'UserPromptSubmit',
        cwd: nested,
        payload: {
          session_id: 's1',
          cwd: nested,
          prompt: 'Fix the cart total',
        },
      }),
      '',
      'every other hook prints nothing',
    )
    // Every hook is reported; the prompt marks the first session working.
    ingestSpool({ hydraId: 'default' })
    const { state } = loadHydra({ hydraId: 'default' })
    const activity = ({ key }: { key: string }) => state.cards[state.keys[key] ?? '']?.activity
    assert.deepEqual(
      [
        's1',
        's2',
        's3',
      ].map(session => activity({ key: `claude:${session}` })),
      [
        'working',
        'finished',
        'finished',
      ],
    )

    const other = join(
      root,
      'docs-site',
    )
    const sibling = join(
      root,
      'shop-old',
    )
    mkdirSync(other)
    mkdirSync(sibling)
    await run({
      args: [
        'project',
        'add',
        other,
      ],
    })
    await run({
      args: [
        'task',
        'create',
        '--title',
        'Other project work',
        '--project',
        'docs-site',
      ],
    })
    await run({
      args: [
        'task',
        'create',
        '--title',
        'Shipped already',
        '--project',
        'shop',
        '--column',
        'done',
      ],
    })

    for (const n of [
      2,
      3,
      4,
      5,
      6,
    ]) {
      await run({
        args: [
          'task',
          'create',
          '--title',
          `Shop task ${n}`,
          '--project',
          'shop',
        ],
      })
    }

    const listed = await context({ cwd: nested })
    assert.match(
      listed,
      /count: 5 of 6 open tasks/,
    )
    assert.doesNotMatch(
      listed,
      /Other project work|Shipped already|Shop task 6/,
      'another project\'s tasks, Done tasks and tasks past the first five stay out',
    )
    assert.equal(
      (await context({ cwd: sibling })).trim(),
      '',
      'a folder whose name only starts with the project\'s is outside it',
    )
  },
)

const REPEAT_SESSION = 'repeat-session'

// One Claude hook event of the repeat session, stamped `second` seconds past noon and ingested at once.
const hookAt = ({
  second,
  event,
  transcript = '/work/home/.claude/projects/-work-repo/repeat-session.jsonl',
  prompt,
}: {
  second: number
  event: string
  transcript?: string
  prompt?: string
}) => {
  const payload: Record<string, unknown> = {
    session_id: REPEAT_SESSION,
    transcript_path: transcript,
    cwd: '/work/repo',
    permission_mode: 'default',
    effort: 'high',
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'toolu_repeat',
  }

  if (prompt) {
    payload.prompt = prompt
  }

  spoolWrite({
    hydraId: 'default',
    entry: {
      v: 1,
      id: `hook-repeat-${event}-${second}`,
      at: `2026-10-29T12:00:${String(second).padStart(
        2,
        '0',
      )}.000Z`,
      harness: 'claude',
      event,
      payload,
    },
  })
  ingestSpool({ hydraId: 'default' })
}

const repeatEvents = () => readEvents({ hydraId: 'default' })
  .filter(event => event.type === 'card.pushed' || event.type === 'card.observed')
  .map(event => `${event.type} ${event.at.slice(
    17,
    19,
  )}`)

const repeatCard = () => Object.values(loadHydra({ hydraId: 'default' }).state.cards)
  .find(card => card.agent?.sessionId === REPEAT_SESSION)!

test(
  'repeated hooks and raw prompts stay in diagnostics while source time advances without events',
  async t => {
    process.env.PNYX_HOME = sandbox().home
    openLogs()
    t.after(() => closeLogs())
    hookAt({
      second: 0,
      event: 'UserPromptSubmit',
      prompt: 'Initial request',
    })
    const before = {
      seq: loadHydra({ hydraId: 'default' }).state.seq,
      revision: repeatCard().revision,
    }
    hookAt({
      second: 20,
      event: 'UserPromptSubmit',
      prompt: 'Initial request',
    })
    hookAt({
      second: 30,
      event: 'UserPromptSubmit',
      prompt: 'New constraint: preserve diagnostics',
    })
    assert.deepEqual(
      repeatEvents(),
      ['card.pushed 00'],
    )
    assert.deepEqual(
      {
        seq: loadHydra({ hydraId: 'default' }).state.seq,
        revision: repeatCard().revision,
      },
      before,
    )
    assert.equal(
      query({ statements: [{ text: 'select observed_at from source_observations' }] })[0]![0]!.observed_at,
      '2026-10-29T12:00:30.000Z',
    )
    await flushLogs()
    const diagnostic = readdirSync(logsDir()).map(name => readFileSync(
      join(
        logsDir(),
        name,
      ),
      'utf8',
    ))
      .join('')
    assert.match(
      diagnostic,
      /New constraint: preserve diagnostics/,
    )
    assert.doesNotMatch(
      JSON.stringify(readEvents({ hydraId: 'default' })),
      /New constraint: preserve diagnostics/,
    )

    const card = repeatCard()
    const facts = withWriter({
      hydraId: 'default',
      fn: ({ writer }) => decidePush({
        state: writer.state,
        key: card.key,
        input: {
          activity: 'working',
          source: {
            ...card.sourceRefs[0],
            observedAt: '2026-10-29T12:00:40.000Z',
          },
        },
        meta: {
          actor: 'hook:claude',
          id: 'new-facts',
          at: '2026-10-29T12:00:40.000Z',
          reason: 'New diagnostic finding',
          details: 'The upstream API returned 503.',
        },
      }),
    })
    assert.equal(
      'skipped' in facts && facts.skipped,
      'unchanged',
      'diagnostic text alone does not change task state',
    )
  },
)

test(
  'a private source watermark rejects older hooks after restart without a repeat event',
  () => {
    process.env.PNYX_HOME = sandbox().home
    hookAt({
      second: 0,
      event: 'PreToolUse',
    })
    hookAt({
      second: 30,
      event: 'PreToolUse',
    })
    spoolWrite({
      hydraId: 'default',
      entry: {
        v: 1,
        id: 'hook-repeat-late-stop',
        at: '2026-10-29T12:00:25.000Z',
        harness: 'claude',
        event: 'Stop',
        payload: {
          session_id: REPEAT_SESSION,
          transcript_path: '/work/home/.claude/projects/-work-repo/repeat-session.jsonl',
          cwd: '/work/repo',
          permission_mode: 'default',
          hook_event_name: 'Stop',
        },
      },
    })
    execFileSync(
      process.execPath,
      [
        '--conditions=source',
        '--input-type=module',
        '-e',
        'const { ingestSpool } = await import(\'#integrations/hooks/ingest.ts\'); ingestSpool({ hydraId: \'default\' })',
      ],
      {
        cwd: ROOT,
        env: process.env,
      },
    )
    assert.deepEqual(
      repeatEvents(),
      ['card.pushed 00'],
    )
    assert.equal(
      repeatCard().sessionActivity,
      'working',
    )
    reloadHydra({ hydraId: 'default' })
    hookAt({
      second: 35,
      event: 'PreToolUse',
    })
    assert.deepEqual(
      repeatEvents(),
      ['card.pushed 00'],
      'the first repeat after restart also stays out of events',
    )
  },
)

test(
  'a transcript record older than a compactly logged hook cannot replace the hook\'s live effort; a newer one does',
  () => {
    const { home } = sandbox()
    process.env.PNYX_HOME = home
    const transcript = join(
      home,
      'repeat-session.jsonl',
    )
    hookAt({
      second: 0,
      event: 'PreToolUse',
      transcript,
    })
    hookAt({
      second: 30,
      event: 'PreToolUse',
      transcript,
    })
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-29T12:00:20.000Z',
        effort: 'low',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [
            {
              type: 'text',
              text: 'Working on it.',
            },
          ],
        },
      })}\n`,
    )
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => harvestTranscripts({
        writer,
        cardIds: [repeatCard().id],
        at: '2026-10-29T12:00:40.000Z',
      }),
    })
    assert.equal(
      repeatCard().settings?.effort,
      'high',
    )

    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-29T12:00:35.000Z',
        effort: 'low',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [
            {
              type: 'text',
              text: 'Switched to low effort.',
            },
          ],
        },
      })}\n`,
    )
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => harvestTranscripts({
        writer,
        cardIds: [repeatCard().id],
        at: '2026-10-29T12:00:45.000Z',
      }),
    })
    assert.equal(
      repeatCard().settings?.effort,
      'low',
    )
  },
)

// Records the turn state Pnyx's host reports for the repeat session it runs.
const hostRecords = ({
  activity,
  second,
}: {
  activity: string
  second: number
}) => {
  const at = `2026-10-29T12:00:${String(second).padStart(
    2,
    '0',
  )}.500Z`

  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => applyDecision({
      writer,
      decision: decidePush({
        state: writer.state,
        key: `claude:${REPEAT_SESSION}`,
        input: {
          activity,
          agent: {
            provider: 'claude-code',
            sessionId: REPEAT_SESSION,
            host: 'pnyx',
          },
          source: {
            adapter: 'pnyx',
            objectId: REPEAT_SESSION,
            observedAt: at,
          },
        },
        meta: {
          at,
          actor: 'pnyx',
        },
      }),
    }),
  })
}

test(
  'a session Pnyx hosts keeps the turn state its host recorded, whatever its own hooks report',
  () => {
    process.env.PNYX_HOME = sandbox().home
    hostRecords({
      activity: 'working',
      second: 0,
    })
    hookAt({
      second: 1,
      event: 'SessionStart',
    })
    hookAt({
      second: 2,
      event: 'SubagentStop',
    })
    hookAt({
      second: 3,
      event: 'Stop',
    })
    assert.equal(
      repeatCard().sessionActivity,
      'working',
      'late finishing hooks leave a running turn working',
    )

    hostRecords({
      activity: 'finished',
      second: 4,
    })
    hookAt({
      second: 5,
      event: 'PreToolUse',
    })
    hookAt({
      second: 6,
      event: 'UserPromptSubmit',
      prompt: 'Late prompt report',
    })
    assert.equal(
      repeatCard().sessionActivity,
      'finished',
      'late working hooks leave an ended turn finished',
    )
  },
)

test(
  'a repeat does not dirty public card rows when a different card changes later',
  () => {
    process.env.PNYX_HOME = sandbox().home
    hookAt({
      second: 0,
      event: 'PreToolUse',
    })
    const card = repeatCard()
    const versions = () => query({
      statements: [
        {
          text: 'select xmin::text as version from card_bodies where card_id = $1',
          values: [card.id],
        },
        {
          text: 'select xmin::text as version from card_references where card_id = $1',
          values: [card.id],
        },
      ],
    })
    const before = versions()
    hookAt({
      second: 20,
      event: 'PreToolUse',
    })
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => applyDecision({
        writer,
        decision: decidePush({
          state: writer.state,
          key: 'unrelated',
          input: { title: 'Another task' },
          meta: {
            at: '2026-10-29T12:01:00.000Z',
            actor: 'test',
            id: 'another-task',
          },
        }),
      }),
    })
    assert.deepEqual(
      versions(),
      before,
    )
  },
)
