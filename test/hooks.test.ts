// Hook payload normalization and spool ingestion. Every path lives in a temporary
// folder: tests never read or edit the real ~/.claude, ~/.codex or ~/.pnyx.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Attention } from '../src/core/model.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { PR_COMMANDS, attend, observe, type HookEnvelope } from '../src/integrations/hooks/observe.ts'
import { readEvents } from '../src/app/event-log.ts'
import { spoolWrite } from '../src/app/spool.ts'
import { spoolFiles } from '../src/store/storage.ts'

const ROOT = join(
  import.meta.dirname,
  '..',
)
const BIN = join(
  ROOT,
  'dist',
  'cli',
  'pnyx-axi.js',
)
const SCRIPT = join(
  ROOT,
  'setup',
  'hooks',
  'pnyx-hook.sh',
)
const FIXTURES = join(
  ROOT,
  'test',
  'fixtures',
  'hooks',
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

function scriptSandbox() {
  // A short base keeps the socket path under the platform's length limit.
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-h-',
  ))
  const home = join(
    root,
    '.pnyx',
  )
  const claude = join(
    root,
    'claude',
  )
  const codex = join(
    root,
    'codex',
  )
  const env = {
    ...process.env,
    HOME: root,
    PNYX_HOME: home,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: codex,
  }
  const run = ({ args }: { args: string[] }) => execFileSync(
    process.execPath,
    [
      BIN,
      ...args,
    ],
    {
      env,
      encoding: 'utf8',
    },
  )
  const spool = join(
    home,
    'hydras',
    'default',
    'spool',
  )
  const spooled = () => (existsSync(spool) ? readdirSync(spool).filter(f => f.endsWith('.json') && !f.startsWith('.')) : [])
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
    spooled,
    script,
  }
}

test(
  'SessionStart prints the open tasks of the attached project holding the folder, and nothing elsewhere',
  () => {
    const {
      root,
      env,
      run,
      script,
      spooled,
    } = scriptSandbox()
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
    run({
      args: [
        'project',
        'add',
        project,
      ],
    })
    run({
      args: [
        'task',
        'create',
        '--title',
        'Fix the cart total',
        '--project',
        'shop',
      ],
    })
    const start = ({
      cwd,
      extra = {},
    }: {
      cwd: string
      extra?: Record<string, string>
    }) => execFileSync(
      '/bin/sh',
      [
        script,
        'claude',
        'SessionStart',
        BIN,
      ],
      {
        cwd,
        input: '{}',
        encoding: 'utf8',
        env: {
          ...env,
          ...extra,
        },
      },
    )

    const summary = start({ cwd: nested })
    assert.match(
      summary,
      /project shop/,
    )
    assert.match(
      summary,
      /Fix the cart total,queued/,
    )
    assert.equal(
      start({ cwd: root }),
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
      execFileSync(
        '/bin/sh',
        [
          script,
          'claude',
          'Stop',
          BIN,
        ],
        {
          cwd: nested,
          input: '{}',
          encoding: 'utf8',
          env,
        },
      ),
      '',
      'every other hook prints nothing',
    )
    assert.equal(
      spooled().length,
      4,
      'every hook is still reported',
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
    run({
      args: [
        'project',
        'add',
        other,
      ],
    })
    run({
      args: [
        'task',
        'create',
        '--title',
        'Other project work',
        '--project',
        'docs-site',
      ],
    })
    run({
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
      run({
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

    const context = ({ cwd }: { cwd: string }) => run({
      args: [
        'context',
        '--cwd',
        cwd,
      ],
    })
    const listed = context({ cwd: nested })
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
      context({ cwd: sibling }).trim(),
      '',
      'a folder whose name only starts with the project\'s is outside it',
    )
  },
)
