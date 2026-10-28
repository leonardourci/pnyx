// The route a reply takes into a hook session's terminal.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Card } from '../../tasks/model.ts'
import { replyRoute, terminalFacts } from '../../workers/reply-route.ts'

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
