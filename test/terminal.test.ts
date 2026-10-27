// Typing replies into a hook session's terminal. Every host (tmux, Paseo, Herdr,
// osascript) and ps is the fake in test/fixtures/hosts on PATH: tests never type
// into a real session.
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { terminalNotice } from '../src/integrations/hooks/terminal.ts'
import type { TerminalRoute } from '../src/core/route.ts'
import type { Card } from '../src/core/model.ts'
import { confirms, findOption, inputReason } from '../src/core/control.ts'
import { replyRoute, terminalFacts } from '../src/core/route.ts'
import { loadHydra } from '../src/store/hydra-store.ts'

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
const HOST = join(
  ROOT,
  'test',
  'fixtures',
  'hosts',
  'host.sh',
)
const TTY = '/dev/ttys042'

function hosts() {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-t-',
  ))
  const bin = join(
    root,
    'bin',
  )
  const stub = join(
    root,
    'stub',
  )
  mkdirSync(bin)
  mkdirSync(stub)

  for (const name of [
    'tmux',
    'paseo',
    'herdr',
    'osascript',
    'ps',
  ]) {
    symlinkSync(
      HOST,
      join(
        bin,
        name,
      ),
    )
  }

  writeFileSync(
    join(
      stub,
      'ps.out',
    ),
    'ttys042\n',
  )
  const env = {
    ...process.env,
    PNYX_HOME: join(
      root,
      'pnyx',
    ),
    STUB_DIR: stub,
    PATH: `${bin}:/usr/bin:/bin`,
  }
  const run = ({ args = [] }: { args?: string[] } = {}) => execFileSync(
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

  const fails = ({
    args,
    code,
  }: {
    args: string[]
    code: string
  }) => {
    try {
      run({ args: [...args] })
    } catch (error) {
      assert.match(
        String((error as { stdout?: string }).stdout),
        new RegExp(`code: ${code}`),
      )

      return
    }

    assert.fail(`expected ${code}`)
  }

  const calls = () => {
    const log = join(
      stub,
      'calls.log',
    )

    return existsSync(log) ? readFileSync(
      log,
      'utf8',
    ).split('---\n')
      .filter(Boolean) : []
  }

  const set = ({
    file,
    text,
  }: {
    file: string
    text: string
  }) =>
    writeFileSync(
      join(
        stub,
        file,
      ),
      text,
    )

  const session = ({
    key,
    terminal,
  }: {
    key: string
    terminal: Record<string, string>
  }) => {
    const file = join(
      root,
      `${key}.json`,
    )
    writeFileSync(
      file,
      JSON.stringify({
        agent: {
          provider: 'claude-code',
          sessionId: key.replace(
            /^claude:/,
            '',
          ),
        },
        terminal: {
          tty: TTY,
          pid: '4242',
          ...terminal,
        },
      }),
    )
    run({
      args: [
        'push',
        '--key',
        key,
        '--file',
        file,
      ],
    })
  }

  return {
    root,
    env,
    run,
    fails,
    calls,
    set,
    session,
  }
}

const card = ({ fields }: { fields: Partial<Card> }): Card => ({
  id: 'c1',
  key: 'k',
  title: 'k',
  workspace: 'unassigned',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  column: 'in_progress',
  revision: 1,
  createdSeq: 1,
  updatedSeq: 1,
  updatedAt: '2026-10-14T00:00:00Z',
  agent: {
    provider: 'claude-code',
    sessionId: 's',
  },
  ...fields,
})

const reason = ({ c }: { c: Card }) => {
  const r = replyRoute({
    card: c,
    homes: [],
  })

  return 'reason' in r ? r.reason : r.route.kind
}

test(
  'the innermost recorded host is the route',
  () => {
    const base = {
      tty: TTY,
      pid: '9',
    }

    for (const [
      fields,
      expected,
    ] of [
        [
          {
            terminal: {
              ...base,
              program: 'tmux',
              tmux: '/tmp/tmux-1/default',
              tmuxPane: '%3',
              paseoTerminal: 'p1',
            },
          },
          /^tmux$/,
        ],
        [
          {
            terminal: {
              ...base,
              program: 'kitty',
              paseoTerminal: 'p1',
              herdrSession: 'h',
              herdrPane: 'p2',
            },
          },
          /^herdr$/,
        ],
        [
          {
            terminal: {
              ...base,
              program: 'kitty',
              paseoTerminal: 'p1',
            },
          },
          /^paseo$/,
        ],
        [
          {
            terminal: {
              ...base,
              program: 'iTerm.app',
            },
          },
          /^iterm2$/,
        ],
        [
          {
            terminal: {
              ...base,
              program: 'Apple_Terminal',
            },
          },
          /^terminal-app$/,
        ],
        [
          {
            terminal: {
              ...base,
              program: 'vscode',
            },
          },
          /cannot type into vscode/,
        ],
        [
          {
            terminal: {
              program: 'tmux',
              tmux: '/tmp/s',
              tmuxPane: '%1',
            },
          },
          /TTY was not found/,
        ],
        [
          {},
          /No terminal is recorded/,
        ],
        [
          {
            activity: 'ended',
            terminal: {
              ...base,
              program: 'Apple_Terminal',
            },
          },
          /session ended/,
        ],
        [
          {
            agent: {
              provider: 'claude-code',
              sessionId: 's',
              agentId: 'a',
            },
          },
          /subagent/,
        ],
        [
          { agent: undefined },
          /no Firstmate task or agent session/,
        ],
      ] as [Partial<Card>, RegExp][]) {
      assert.match(
        reason({ c: card({ fields }) }),
        expected,
      )
    }

    const fm = card({
      fields: {
        sourceRefs: [
          {
            adapter: 'firstmate',
            instanceId: '/fm',
            objectId: 'task',
          },
        ],
        terminal: {
          ...base,
          program: 'Apple_Terminal',
        },
      },
    })
    assert.match(
      reason({ c: fm }),
      /not configured/,
    )
    assert.deepEqual(
      replyRoute({
        card: fm,
        homes: ['/fm'],
      }),
      {
        route: {
          kind: 'firstmate',
          home: '/fm',
          task: 'task',
        },
      },
    )
    assert.deepEqual(
      replyRoute({
        card: {
          ...fm,
          agent: {
            provider: 'claude-code',
            sessionId: 's',
            host: 'pnyx',
            resume: true,
          },
        },
        homes: [],
      }),
      { route: { kind: 'pnyx' } },
    )
    assert.deepEqual(
      terminalFacts({
        value: {
          tty: TTY,
          tmuxPane: '-t',
          program: 'a b',
          pid: '0',
          paseoTerminal: '--x',
          extra: 'y',
        },
      }),
      { tty: TTY },
    )
  },
)

test(
  'a tmux reply checks the pane, pastes once and presses Enter',
  () => {
    const {
      run,
      calls,
      set,
      session,
      fails,
    } = hosts()
    session({
      key: 's1',
      terminal: {
        program: 'tmux',
        tmux: '/tmp/tmux-1/default',
        tmuxPane: '%3',
      },
    })
    set({
      file: 'tmux.out.1',
      text: `${TTY}\n`,
    })
    const out = run({
      args: [
        'reply',
        's1',
        '--text',
        'first line\nsecond line',
        '--idempotency-key',
        'k1',
      ],
    })
    assert.match(
      out,
      /state: delivered/,
    )
    const log = calls()
    assert.deepEqual(
      log.map(c => c.split('\n')[0]),
      [
        'call=ps',
        'call=tmux',
        'call=tmux',
        'call=tmux',
        'call=tmux',
      ],
    )
    assert.match(
      log[0]!,
      /arg=-p\narg=4242/,
    )
    assert.match(
      log[1]!,
      /arg=-S\narg=\/tmp\/tmux-1\/default\narg=display-message\narg=-p\narg=-t\narg=%3\narg=#\{pane_tty\}/,
    )
    assert.match(
      log[2]!,
      /arg=load-buffer[\s\S]*stdin=first line\nsecond line/,
    )
    assert.match(
      log[3]!,
      /arg=paste-buffer\narg=-p\narg=-d[\s\S]*arg=-t\narg=%3/,
    )
    assert.match(
      log[4]!,
      /arg=send-keys\narg=-t\narg=%3\narg=Enter\n$/,
    )
    assert.match(
      run({
        args: [
          'reply',
          's1',
          '--text',
          'first line\nsecond line',
          '--idempotency-key',
          'k1',
        ],
      }),
      /sent: false/,
    )
    assert.equal(
      calls().length,
      5,
    )
    fails({
      args: [
        'reply',
        's1',
        '--text',
        'x',
        '--resolve-key',
        'k',
      ],
      code: 'VALIDATION_ERROR',
    })
  },
)

test(
  'a changed pane or an exited process types nothing',
  () => {
    const {
      run,
      calls,
      set,
      session,
    } = hosts()
    session({
      key: 's1',
      terminal: {
        program: 'tmux',
        tmux: '/tmp/tmux-1/default',
        tmuxPane: '%3',
      },
    })
    set({
      file: 'tmux.out',
      text: '/dev/ttys099\n',
    })
    assert.match(
      run({
        args: [
          'reply',
          's1',
          '--text',
          'hi',
        ],
      }),
      /state: failed\n {2}detail: tmux pane %3 no longer shows \/dev\/ttys042; nothing was typed/,
    )
    assert.equal(
      calls().filter(c => /load-buffer|paste-buffer|send-keys/.test(c)).length,
      0,
    )

    set({
      file: 'ps.out',
      text: '',
    })
    set({
      file: 'ps.exit',
      text: '1',
    })
    assert.match(
      run({
        args: [
          'reply',
          's1',
          '--text',
          'hi',
        ],
      }),
      /detail: the session's process 4242 has exited; nothing was typed/,
    )
    set({
      file: 'ps.exit',
      text: '0',
    })
    set({
      file: 'ps.out',
      text: 'ttys007\n',
    })
    assert.match(
      run({
        args: [
          'reply',
          's1',
          '--text',
          'hi',
        ],
      }),
      /detail: process 4242 no longer runs on \/dev\/ttys042/,
    )
    assert.equal(
      calls().filter(c => c.startsWith('call=tmux')).length,
      1,
    )
  },
)

test(
  'iTerm2 and Terminal get the text and TTY as AppleScript arguments',
  () => {
    const {
      run,
      calls,
      set,
      session,
    } = hosts()
    session({
      key: 's1',
      terminal: { program: 'iTerm.app' },
    })
    session({
      key: 's2',
      terminal: { program: 'Apple_Terminal' },
    })
    assert.match(
      run({
        args: [
          'reply',
          's1',
          '--text',
          'say "hi"',
        ],
      }),
      /state: delivered/,
    )
    const iterm = calls()[1]!
    assert.match(
      iterm,
      /tell application "iTerm2"[\s\S]*end run\narg=\/dev\/ttys042\narg=say "hi"\narg=0.4\n$/,
    )
    assert.match(
      run({
        args: [
          'reply',
          's2',
          '--text',
          'hello',
        ],
      }),
      /state: delivered/,
    )
    assert.match(
      calls()[3]!,
      /tell application "Terminal"/,
    )

    set({
      file: 'osascript.exit',
      text: '1',
    })
    set({
      file: 'osascript.err',
      text: 'execution error: no Terminal tab on /dev/ttys042 (4404)',
    })
    assert.match(
      run({
        args: [
          'reply',
          's2',
          '--text',
          'hello',
        ],
      }),
      /state: failed[\s\S]*nothing was typed/,
    )
    set({
      file: 'osascript.err',
      text: 'execution error: Not authorized to send Apple events to Terminal. (-1743)',
    })
    assert.match(
      run({
        args: [
          'reply',
          's2',
          '--text',
          'hello',
        ],
      }),
      /state: failed[\s\S]*Privacy & Security > Automation/,
    )
    set({
      file: 'osascript.err',
      text: 'execution error: something else (-2700)',
    })
    assert.match(
      run({
        args: [
          'reply',
          's2',
          '--text',
          'hello',
        ],
      }),
      /state: delivery_unknown/,
    )
  },
)

const execFileAsync = promisify(execFile)

test(
  'the hook records the terminal the session runs in, past wrapper shells, and none for a headless run',
  async () => {
    const {
      root,
      env,
    } = hosts()
    const home = join(
      root,
      'pnyx',
    )
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
      join(
        ROOT,
        'setup',
        'hooks',
        'pnyx-hook.sh',
      ),
      script,
    )
    writeFileSync(
      join(
        env.STUB_DIR,
        'ps.out.1',
      ),
      '777 ttys042 -zsh\n',
    )
    writeFileSync(
      join(
        env.STUB_DIR,
        'ps.out.2',
      ),
      '1 ttys042 /usr/local/bin/claude\n',
    )
    const hostEnv = {
      PATH: env.PATH,
      STUB_DIR: env.STUB_DIR,
      TERM_PROGRAM: 'tmux',
      TMUX: '/tmp/tmux-501/default,123,0',
      TMUX_PANE: '%5',
      PASEO_TERMINAL_ID: 'term-1',
      PASEO_ACTIVITY_TOKEN: 'secret',
    }
    const child = execFileAsync(
      '/bin/sh',
      [
        script,
        'claude',
        'SessionStart',
      ],
      {
        encoding: 'utf8',
        env: hostEnv,
      },
    )
    child.child.stdin!.end('{"session_id":"s1","cwd":"/work"}')
    const {
      stdout,
      stderr,
    } = await child
    assert.equal(
      stdout + stderr,
      '',
    )
    const spool = join(
      home,
      'hydras',
      'default',
      'spool',
    )
    const line = JSON.parse(readFileSync(
      join(
        spool,
        readdirSync(spool)[0]!,
      ),
      'utf8',
    ))
    assert.deepEqual(
      line.terminal,
      {
        tty: TTY,
        pid: '777',
        program: 'tmux',
        tmux: '/tmp/tmux-501/default',
        tmuxPane: '%5',
        paseoTerminal: 'term-1',
      },
    )
    assert.doesNotMatch(
      JSON.stringify(line),
      /secret/,
    )

    execFileSync(
      process.execPath,
      [
        BIN,
        'harvest',
      ],
      {
        env: {
          ...env,
          PNYX_HOME: home,
        },
        encoding: 'utf8',
      },
    )
    process.env.PNYX_HOME = home
    const { state } = loadHydra({ hydraId: 'default' })
    assert.deepEqual(
      state.cards[state.keys['claude:s1']!]!.terminal,
      line.terminal,
    )

    // A headless harness that session started records no tty or pid of its own.
    writeFileSync(
      join(
        env.STUB_DIR,
        'ps.out.3',
      ),
      '888 ?? zsh\n',
    )
    writeFileSync(
      join(
        env.STUB_DIR,
        'ps.out.4',
      ),
      '777 ?? /usr/local/bin/claude\n',
    )
    writeFileSync(
      join(
        env.STUB_DIR,
        'ps.out.5',
      ),
      '1 ttys042 /usr/local/bin/claude\n',
    )
    const headless = execFileAsync(
      '/bin/sh',
      [
        script,
        'claude',
        'SessionStart',
      ],
      {
        encoding: 'utf8',
        env: hostEnv,
      },
    )
    headless.child.stdin!.end('{"session_id":"s2","cwd":"/work"}')
    await headless
    const [file] = readdirSync(spool).filter(f => f.endsWith('.json'))
    assert.deepEqual(
      JSON.parse(readFileSync(
        join(
          spool,
          file!,
        ),
        'utf8',
      )).terminal,
      {
        program: 'tmux',
        tmux: '/tmp/tmux-501/default',
        tmuxPane: '%5',
        paseoTerminal: 'term-1',
      },
    )

    const tool = execFileAsync(
      '/bin/sh',
      [
        script,
        'claude',
        'PreToolUse',
      ],
      {
        encoding: 'utf8',
        env: hostEnv,
      },
    )
    tool.child.stdin!.end('{"session_id":"s1","cwd":"/work","tool_name":"Bash","tool_input":{"command":"ls"}}')
    await tool
    const lines = readdirSync(spool).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(
        join(
          spool,
          f,
        ),
        'utf8',
      )) as {
        event: string
        terminal?: object
      })
    assert.deepEqual(
      lines.find(l => l.event === 'PreToolUse')?.terminal,
      { paseoTerminal: 'term-1' },
    )
    execFileSync(
      process.execPath,
      [
        BIN,
        'harvest',
      ],
      {
        env: {
          ...env,
          PNYX_HOME: home,
        },
        encoding: 'utf8',
      },
    )
    const after = loadHydra({ hydraId: 'default' }).state
    assert.deepEqual(
      after.cards[after.keys['claude:s1']!]!.terminal,
      line.terminal,
    )
  },
)

test(
  "a session's report confirms a change the way its control reads back",
  () => {
    const check = ({
      provider,
      setting,
      value,
      before,
      after,
    }: {
      provider: string
      setting: string
      value: string
      before?: string
      after?: string
    }) =>
      confirms({
        ...findOption({
          provider,
          setting,
          value,
        })!,
        before,
        after,
      })

    for (const [
      provider,
      setting,
      value,
      before,
      after,
      confirmed,
    ] of [
        [
          'claude-code',
          'model',
          'opus',
          'claude-sonnet-5-5',
          'claude-opus-5-5',
          true,
        ],
        [
          'claude-code',
          'model',
          'opus',
          'claude-sonnet-5-5',
          'claude-sonnet-5-5',
          false,
        ],
        [
          'claude-code',
          'effort',
          'high',
          'medium',
          'high',
          true,
        ],
        [
          'claude-code',
          'effort',
          'xhigh',
          'medium',
          'high',
          false,
        ],
        [
          'claude-code',
          'mode',
          'next',
          'auto',
          'default',
          true,
        ],
        [
          'codex',
          'effort',
          'raise',
          'medium',
          'medium',
          false,
        ],
        [
          'codex',
          'fast',
          'toggle',
          'off',
          undefined,
          false,
        ],
      ] as const) {
      assert.equal(
        check({
          provider,
          setting,
          value,
          before,
          after,
        }),
        confirmed,
        `${provider} ${setting} ${value}`,
      )
    }

    assert.equal(
      findOption({
        provider: 'codex',
        setting: 'model',
        value: 'gpt-6',
      }),
      undefined,
    )

    for (const [
      setting,
      value,
    ] of [
        [
          'model',
          'gpt-6.1-sol',
        ],
        [
          'approval',
          'on-request',
        ],
      ]) {
      assert.equal(
        findOption({
          provider: 'codex',
          setting: setting!,
          value: value!,
        }),
        undefined,
      )
      const picked = findOption({
        provider: 'codex',
        setting: setting!,
        value: value!,
        firstmate: true,
      })
      assert.ok(
        picked,
        `${setting} must be requestable on a Firstmate Codex card`,
      )
      assert.deepEqual(
        picked.option.input,
        { request: true },
      )
      assert.equal(
        inputReason({
          kind: 'firstmate',
          input: picked.option.input,
        }),
        undefined,
      )
      assert.match(
        inputReason({
          kind: 'tmux',
          input: picked.option.input,
        })!,
        /only be requested through Firstmate/,
      )
      assert.equal(
        confirms({
          ...picked,
          before: undefined,
          after: value,
        }),
        true,
      )
      assert.equal(
        confirms({
          ...picked,
          before: 'old',
          after: 'different',
        }),
        false,
      )
    }

    assert.equal(
      findOption({
        provider: 'opencode',
        setting: 'effort',
        value: 'high',
      }),
      undefined,
    )
  },
)

test(
  'inbox doorbells protect drafts and prompts, detect dead workers and only submit a verified empty tmux composer',
  () => {
    const route = {
      kind: 'tmux' as const,
      socket: '/tmp/fake.sock',
      pane: '%1',
      tty: TTY,
      pid: 4242,
    }
    let screen = 'history\n❯ \n'
    let processStatus = 0
    const sent: string[] = []
    const base = card({ fields: { activity: 'finished' } })
    const ring = ({
      worker = base,
      target = route,
    }: {
      worker?: Card
      target?: TerminalRoute
    } = {}) => terminalNotice({
      route: target,
      text: 'inbox notice with exact IDs',
      card: worker,
      execute: ({
        command,
        args,
      }) => {
        const stdout = command === 'ps' ? 'ttys042\n'
          : args.includes('capture-pane') ? screen : `${TTY}\t1\n`

        return {
          pid: 0,
          output: [
            '',
            stdout,
            '',
          ],
          stdout,
          stderr: '',
          status: command === 'ps' ? processStatus : 0,
          signal: null,
        }
      },
      send: ({ text }) => {
        sent.push(text)

        return { state: 'delivered' }
      },
    })
    assert.equal(
      ring().result,
      'delivered',
    )
    screen = 'history\n❯ my unsent human draft\n'
    assert.equal(
      ring().result,
      'deferred',
    )
    screen = 'history\n❯ \nsecond line of a human draft\n────────\nstatus'
    assert.equal(
      ring().result,
      'deferred',
    )
    screen = 'history\nApprove?\n'
    assert.equal(
      ring().result,
      'unknown',
    )
    assert.equal(
      ring({
        worker: {
          ...base,
          activity: 'working',
        },
      }).result,
      'deferred',
    )
    assert.equal(
      ring({
        worker: {
          ...base,
          attention: [
            {
              kind: 'permission',
              key: 'hook:permission',
              blocking: true,
              text: 'Allow?',
            },
          ],
        },
      }).result,
      'deferred',
    )
    processStatus = 1
    assert.equal(
      ring().result,
      'gone',
    )
    processStatus = 0
    assert.equal(
      ring({
        target: {
          kind: 'iterm2',
          tty: TTY,
          pid: 4242,
        },
      }).result,
      'unknown',
    )
    assert.deepEqual(
      sent,
      ['inbox notice with exact IDs'],
    )
    const missingHost = terminalNotice({
      route,
      text: 'inbox notice',
      card: base,
      execute: ({ command }) => command === 'ps'
        ? {
          pid: 0,
          output: [
            '',
            'ttys042',
            '',
          ],
          stdout: 'ttys042',
          stderr: '',
          status: 0,
          signal: null,
        }
        : spawnSync(
          'pnyx-inbox-fixture-missing-command',
          [],
          { encoding: 'utf8' },
        ),
      send: () => assert.fail('an unavailable host must receive nothing'),
    })
    assert.equal(
      missingHost.result,
      'unknown',
    )
  },
)
