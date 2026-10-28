import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolCall } from '#hydra/calls.ts'
import { actionLabel, currentLabel, shellOf } from './action-label.ts'
import type { PnyxLookup } from './pnyx-action.ts'
import { withChanges } from '#web-app/connection.ts'

const lookup: PnyxLookup = {
  task: ({ ref }) => ref === 'login' ? {
    id: 'task-1',
    title: 'Fix login loop',
  } : undefined,
  column: ({ ref }) => ref === 'needs_you' ? {
    id: 'custom:1',
    title: 'Needs you',
    role: 'needs_you',
  } : undefined,
}

const label = ({ calls }: { calls: Omit<ToolCall, 'id'>[] }) => actionLabel({
  action: {
    calls: calls.map((
      call,
      index,
    ) => ({
      id: `call_${index}`,
      ...call,
    })),
    done: false,
  },
  lookup,
})

const shell = ({
  command,
  description,
}: {
  command: string
  description?: string
}) => {
  const call: Omit<ToolCall, 'id'> = {
    tool: 'Bash',
    command,
  }

  if (description) {
    call.description = description
  }

  return label({ calls: [call] })
}

const says = ({ command }: { command: string }) => shell({ command })?.sentence.join('')

test(
  'Known shell commands get Pnyx\'s own words and icon, past wrappers and runners',
  () => {
    const cases: [string, string, string][] = [
      [
        'gh pr view 4728 --comments',
        'Reading PR #4728',
        'github',
      ],
      [
        'gh-axi pr create --title "Fix" --body x',
        'Opening a PR',
        'github',
      ],
      [
        'gh pr checks 12',
        'Checking CI on PR #12',
        'github',
      ],
      [
        'gh issue view 212',
        'Reading issue #212',
        'github',
      ],
      [
        'gh run list --limit 3',
        'Checking CI',
        'github',
      ],
      [
        'rtk proxy sh -c \'nl -ba src/thread/read.ts | sed -n "1,9p"\'',
        'Reading read.ts',
        'file',
      ],
      [
        'cd web && PNYX_HOME=/tmp/x pnpm test',
        'Running tests',
        'test',
      ],
      [
        'node --test test/calls.test.ts',
        'Running tests',
        'test',
      ],
      [
        'pnpm run lint',
        'Running lint',
        'lint',
      ],
      [
        'tsc --noEmit -p web',
        'Running lint',
        'lint',
      ],
      [
        'pnpm install',
        'Installing packages',
        'build',
      ],
      [
        'pnpm build',
        'Building',
        'build',
      ],
      [
        'git push origin fm/x',
        'Pushing',
        'git',
      ],
      [
        'git diff --stat',
        'Checking changes',
        'git',
      ],
      [
        'rg -n postLine src',
        'Searching for postLine',
        'search',
      ],
      [
        'grep -rn "chat-running\\|dots" web/src',
        'Searching the code',
        'search',
      ],
      [
        'ls -la .lavish',
        'Looking at files',
        'search',
      ],
      [
        'sed -i \'\' \'s/a/b/\' web/src/index.css',
        'Editing index.css',
        'edit',
      ],
      [
        'cat ~/.agents/skills/review-code/SKILL.md',
        'Running review',
        'review',
      ],
      [
        'cat ~/.agents/skills/commit/SKILL.md',
        'Using commit',
        'skill',
      ],
      [
        'no-mistakes run',
        'Running review',
        'review',
      ],
      [
        'curl -s https://api.github.com/repos/x/y',
        'Opening api.github.com',
        'world',
      ],
      [
        'chrome-devtools-axi screenshot /tmp/a.png',
        'Using the browser',
        'world',
      ],
      [
        'sleep 30',
        'Waiting',
        'wait',
      ],
      [
        'lavish-axi poll .lavish/board/index.html',
        'Waiting',
        'wait',
      ],
      [
        'gh run watch 123',
        'Waiting',
        'wait',
      ],
      [
        'gh pr merge 4728 --merge',
        'Merging PR #4728',
        'github',
      ],
      [
        'gh pr list --limit 3',
        'Listing PRs',
        'github',
      ],
      [
        'gh issue list --limit 50',
        'Listing issues',
        'github',
      ],
      [
        'gh pr checks --watch --interval 30',
        'Checking CI on PR',
        'github',
      ],
      [
        'gh pr ready 12',
        'Working on PR',
        'github',
      ],
      [
        'git -C /repo status --short',
        'Checking changes',
        'git',
      ],
      [
        'git commit -m "fix"',
        'Committing',
        'git',
      ],
      [
        'git grep -n postLine',
        'Searching the code',
        'search',
      ],
      [
        'git worktree list',
        'Using git',
        'git',
      ],
      [
        'pnpm -C web test',
        'Running tests',
        'test',
      ],
      [
        'timeout -s KILL 30 pnpm test',
        'Running tests',
        'test',
      ],
      [
        'sudo env FOO=1 rtk git status',
        'Checking changes',
        'git',
      ],
      [
        'cd "my dir" && pnpm lint',
        'Running lint',
        'lint',
      ],
      [
        '/usr/bin/zsh -lc "pnpm test"',
        'Running tests',
        'test',
      ],
      [
        'pytest -q',
        'Running tests',
        'test',
      ],
    ]

    for (const [
      command,
      words,
      icon,
    ] of cases) {
      assert.deepEqual(
        shell({ command }),
        {
          icon,
          sentence: [words],
        },
        command,
      )
    }
  },
)

test(
  'A command with no rule shows the agent\'s own words, else the program, else a plain command',
  () => {
    assert.equal(
      shell({
        command: 'python3 - <<\'EOF\'\nimport json\nEOF',
        description: 'Measure label coverage',
      })?.sentence.join(''),
      'Measure label coverage',
    )
    assert.equal(
      says({ command: 'python3 - <<\'EOF\'\nimport os.path\nEOF' }),
      'Running python3',
    )
    assert.equal(
      says({ command: 'rtk proxy pnpm exec tsx scripts/seed.ts' }),
      'Running seed.ts',
    )
    assert.equal(
      says({ command: './bin/fm-wake-drain.sh --home ~/fm' }),
      'Running fm-wake-drain',
    )
    assert.equal(
      says({ command: 'for f in test/*.ts; do wc -l "$f"; done' }),
      'Running a command',
    )
    assert.equal(
      label({ calls: [{ tool: 'clock__curr_time' }] })?.sentence.join(''),
      'Using clock__curr_time',
    )
    // A known command keeps Pnyx's own words even when the agent described it.
    assert.equal(
      shell({
        command: 'pnpm test',
        description: 'Run the suite',
      })?.sentence.join(''),
      'Running tests',
    )
  },
)

test(
  'Calls made together count up when they read or edit files, and bookkeeping calls give no label',
  () => {
    assert.deepEqual(
      label({
        calls: [
          {
            tool: 'exec_command',
            command: 'cat a.ts',
          },
          {
            tool: 'Read',
            file: 'b.ts',
          },
          {
            tool: 'exec_command',
            command: 'sed -n 1,9p c.ts',
          },
        ],
      }),
      {
        icon: 'file',
        sentence: ['Reading 3 files'],
      },
    )
    assert.deepEqual(
      label({
        calls: [
          {
            tool: 'exec_command',
            command: 'git status',
          },
          {
            tool: 'exec_command',
            command: 'pnpm test',
          },
        ],
      })?.sentence,
      ['Checking changes'],
    )
    assert.equal(
      label({ calls: [{ tool: 'ToolSearch' }] }),
      undefined,
    )
    assert.equal(
      label({ calls: [{ tool: 'TodoWrite' }] }),
      undefined,
    )
  },
)

test(
  'A shell line is judged by its real first command',
  () => {
    assert.deepEqual(
      shellOf({ command: 'cd /repo && cd web; FOO=1 timeout 30 rtk proxy npx -y vitest run' }),
      {
        program: 'vitest',
        args: ['run'],
        line: 'vitest run',
      },
    )
    assert.equal(
      shellOf({ command: 'bash -lc \'git log --oneline -3\'' })?.line,
      'git log --oneline -3',
    )
    assert.equal(
      shellOf({ command: '   ' }),
      undefined,
    )
  },
)

test(
  'Files edited together count up, bookkeeping calls drop out, and an unknown Pnyx command still says Pnyx',
  () => {
    assert.deepEqual(
      label({
        calls: [
          {
            tool: 'Edit',
            file: 'a.ts',
          },
          {
            tool: 'Edit',
            file: 'b.ts',
          },
        ],
      }),
      {
        icon: 'edit',
        sentence: ['Editing 2 files'],
      },
    )
    assert.deepEqual(
      label({
        calls: [
          { tool: 'ToolSearch' },
          {
            tool: 'Read',
            file: 'a.ts',
          },
        ],
      })?.sentence,
      ['Reading a.ts'],
    )

    for (const tool of [
      'update_plan',
      'request_user_input',
      'AskUserQuestion',
      'ExitPlanMode',
      'TaskCreate',
    ]) {
      assert.equal(
        label({ calls: [{ tool }] }),
        undefined,
        tool,
      )
    }

    assert.deepEqual(
      shell({ command: 'pnyx-axi frobnicate now' }),
      {
        icon: 'pnyx',
        sentence: ['Using Pnyx'],
      },
    )
  },
)

test(
  'The current label hides a call from an earlier turn and keeps the shown label for bookkeeping calls',
  () => {
    const action = ({
      tool,
      at,
    }: {
      tool: string
      at: string
    }) => ({
      calls: [
        {
          id: 'call_1',
          tool,
          file: 'a.ts',
        },
      ],
      at,
      done: false,
    })
    const since = '2026-10-22T10:00:00.000Z'

    assert.equal(
      currentLabel({
        action: action({
          tool: 'Read',
          at: '2026-10-22T09:59:00.000Z',
        }),
        since,
        lookup,
      }),
      null,
    )
    assert.deepEqual(
      currentLabel({
        action: action({
          tool: 'Read',
          at: '2026-10-22T09:59:58.000Z',
        }),
        since,
        lookup,
      })?.sentence,
      ['Reading a.ts'],
    )
    assert.deepEqual(
      currentLabel({
        action: action({
          tool: 'Read',
          at: '2026-10-22T09:00:00.000Z',
        }),
        lookup,
      })?.sentence,
      ['Reading a.ts'],
    )
    assert.equal(
      currentLabel({
        action: action({
          tool: 'ToolSearch',
          at: '2026-10-22T10:00:01.000Z',
        }),
        since,
        lookup,
      }),
      undefined,
    )
    assert.equal(
      currentLabel({ lookup }),
      null,
    )
  },
)

test(
  'A push sets the cards it names, drops the ones sent as null and leaves the rest alone',
  () => {
    const current = {
      a: 'old a',
      b: 'old b',
      c: 'old c',
    }

    assert.deepEqual(
      withChanges({
        current,
        changes: {
          a: 'new a',
          b: null,
        },
      }),
      {
        a: 'new a',
        c: 'old c',
      },
    )
    assert.deepEqual(
      current,
      {
        a: 'old a',
        b: 'old b',
        c: 'old c',
      },
    )
  },
)
