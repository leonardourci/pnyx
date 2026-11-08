// The route a reply takes into a hook session's terminal.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { terminalNotice, typeInto } from './terminal.ts'
import type { Card } from '#tasks/model.ts'
import { replyRoute, terminalFacts } from '#workers/reply-route.ts'

const TTY = '/dev/ttys042'

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
  'a busy terminal notice verifies process exit before deferring without typing',
  async () => {
    const busy = card({ fields: { sessionActivity: 'working' } })
    const route = {
      kind: 'terminal-app' as const,
      tty: TTY,
      pid: 9,
    }
    const send = async () => assert.fail('a busy or dead worker must receive no typed input')
    assert.deepEqual(
      await terminalNotice({
        card: busy,
        route,
        text: 'Read the inbox',
        send,
        execute: async () => ({
          status: 0,
          stdout: 'ttys042',
          stderr: '',
        }),
      }),
      {
        result: 'deferred',
        busy: true,
        detail: 'terminal worker is busy; notification waits for an idle composer',
      },
    )
    assert.deepEqual(
      await terminalNotice({
        card: busy,
        route,
        text: 'Read the inbox',
        send,
        execute: async () => ({
          status: 1,
          stdout: '',
          stderr: '',
        }),
      }),
      {
        result: 'gone',
        detail: 'worker process exited; attach a live worker to read the inbox',
      },
    )
  },
)

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
  'two replies sent at once to panes of one tmux server each paste their own words',
  async t => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-terminal-',
    ))
    const path = process.env.PATH
    process.env.PATH = `${join(
      import.meta.dirname,
      'fixtures',
      'terminal',
    )}:${path}`
    process.env.FAKE_TERMINAL_DIR = dir
    t.after(() => {
      process.env.PATH = path
      delete process.env.FAKE_TERMINAL_DIR
      rmSync(
        dir,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const send = ({
      pane,
      text,
    }: {
      pane: string
      text: string
    }) => typeInto({
      route: {
        kind: 'tmux',
        socket: '/tmp/fake-tmux',
        pane,
        tty: '/dev/ttys001',
        pid: 1,
      },
      text,
    })

    const results = await Promise.all([
      send({
        pane: '%1',
        text: 'OWNER_A',
      }),
      send({
        pane: '%2',
        text: 'OWNER_B',
      }),
    ])

    assert.deepEqual(
      results.map(result => result.state),
      [
        'delivered',
        'delivered',
      ],
    )
    assert.deepEqual(
      readFileSync(
        join(
          dir,
          'pasted',
        ),
        'utf8',
      ).trim()
        .split('\n')
        .sort(),
      [
        '%1\tOWNER_A',
        '%2\tOWNER_B',
      ],
    )
  },
)
