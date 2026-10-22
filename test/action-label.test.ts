import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolCall } from '../src/thread/calls.ts'
import { actionLabel, shellOf } from '../web/src/hydra/action-label.ts'
import type { PnyxLookup } from '../web/src/hydra/pnyx-action.ts'

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
}) => label({
  calls: [
    {
      tool: 'Bash',
      command,
      ...(description ? { description } : {}),
    },
  ],
})

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
  'Agent tools are named by what they do',
  () => {
    const cases: [Omit<ToolCall, 'id'>, string, string][] = [
      [
        {
          tool: 'Read',
          file: '/repo/web/src/app.tsx',
        },
        'Reading app.tsx',
        'file',
      ],
      [
        {
          tool: 'Edit',
          file: '/repo/web/src/app.tsx',
        },
        'Editing app.tsx',
        'edit',
      ],
      [
        {
          tool: 'Write',
          file: 'notes.md',
        },
        'Writing notes.md',
        'edit',
      ],
      [
        {
          tool: 'apply_patch',
          file: 'web/src/app.tsx',
        },
        'Editing app.tsx',
        'edit',
      ],
      [
        {
          tool: 'Grep',
          query: 'postLine',
        },
        'Searching for postLine',
        'search',
      ],
      [
        {
          tool: 'Glob',
          query: '**/*.ts',
        },
        'Looking at files',
        'search',
      ],
      [
        {
          tool: 'Skill',
          skill: 'review-code',
        },
        'Running review',
        'review',
      ],
      [
        {
          tool: 'Skill',
          skill: 'create-pr',
        },
        'Using create-pr',
        'skill',
      ],
      [
        {
          tool: 'Agent',
          skill: 'functional-agents:functional-inspector',
        },
        'Running review',
        'review',
      ],
      [
        {
          tool: 'Agent',
          skill: 'Explore',
        },
        'Running a helper',
        'agent',
      ],
      [
        {
          tool: 'WebFetch',
          url: 'https://github.com/leonardourci/pnyx',
        },
        'Opening github.com',
        'world',
      ],
      [
        { tool: 'WebSearch' },
        'Searching the web',
        'world',
      ],
      [
        { tool: 'mcp__claude_ai_Linear__get_issue' },
        'Using Linear',
        'plug',
      ],
      [
        { tool: 'mcp__plugin_playwright_playwright__browser_click' },
        'Using the browser',
        'world',
      ],
      [
        { tool: 'mcp__github__get_pull_request' },
        'Using GitHub',
        'github',
      ],
      [
        { tool: 'write_stdin' },
        'Waiting',
        'wait',
      ],
    ]

    for (const [
      call,
      words,
      icon,
    ] of cases) {
      assert.deepEqual(
        label({ calls: [call] }),
        {
          icon,
          sentence: [words],
        },
        call.tool,
      )
    }
  },
)

test(
  'Pnyx\'s own commands read in the present tense, with their task and column chips and no reason',
  () => {
    assert.deepEqual(
      shell({ command: 'pnyx-axi move login needs_you --reason "waiting on the owner"' }),
      {
        icon: 'pnyx',
        sentence: [
          'Moving ',
          {
            task: 'task-1',
            label: 'Fix login loop',
          },
          ' to ',
          {
            column: {
              id: 'custom:1',
              role: 'needs_you',
            },
            label: 'Needs you',
          },
        ],
      },
    )
    assert.deepEqual(
      shell({ command: 'PNYX_HOME=/tmp/x node dist/cli/pnyx-axi.js hydra check' })?.sentence,
      ['Checking what changed'],
    )
    assert.deepEqual(
      shell({ command: 'pnyx-axi task show login' })?.sentence,
      [
        'Reading ',
        {
          task: 'task-1',
          label: 'Fix login loop',
        },
      ],
    )
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
