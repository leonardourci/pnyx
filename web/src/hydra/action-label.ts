import type { CurrentAction, ToolCall } from '../../../src/thread/calls.ts'
import { pnyxSentence, pnyxWords, shellWords, type PnyxLookup, type Segment } from './pnyx-action.ts'

// What the running line and a working card say an agent is doing, and its icon.
export interface ActionLabel {
  icon: string
  sentence: Segment[]
}

// A shell line reduced to its program and words, past wrappers and runners.
interface Shell {
  program: string
  args: string[]
  line: string
}

interface Rule {
  icon: string
  tool?: RegExp
  shell?: RegExp
  // A further check on what the call names, such as the skill a review runs.
  when?({
    call,
    shell,
  }: {
    call: ToolCall
    shell?: Shell
  }): boolean
  say({
    call,
    shell,
  }: {
    call: ToolCall
    shell?: Shell
  }): string
}

const SHELL_TOOLS = /^(Bash|exec_command|shell|local_shell|container\.exec)$/
// Bookkeeping, not work: these leave the label as it was.
const HIDDEN_TOOLS = /^(ToolSearch|TodoWrite|Task(Create|Update|List|Get)|AskUserQuestion|EnterPlanMode|ExitPlanMode|update_plan|request_user_input\w*)$/
const SH_WRAPPER = /^(\/bin\/)?(ba|z)?sh$/
const LEADING_CD = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/
const RUNNERS = new Set([
  'rtk',
  'proxy',
  'env',
  'exec',
  'sudo',
  'command',
  'time',
  'nohup',
  'npx',
  'bunx',
  '-y',
])
const PACKAGE_RUNNERS = /^(pnpm|yarn|npm|bun)$/
const INTERPRETERS = /^(python3?|node|bash|sh|zsh|tsx|ts-node|deno|ruby|perl|bun)$/
// Shell keywords and file chores say nothing about the work, so they read as a plain command.
const PLAIN = new Set([
  'for',
  'while',
  'until',
  'if',
  'case',
  '{',
  '(',
  '[',
  '[[',
  'test',
  'true',
  'false',
  'export',
  'echo',
  'printf',
  'cd',
  'pwd',
  'set',
  'source',
  '.',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'touch',
  'chmod',
  'ln',
  'date',
  'ps',
  'kill',
  'pkill',
  'exit',
  'unset',
  'read',
  'eval',
  'trap',
])
const PLAIN_WORD = /^[\w.-]{2,24}$/
const PATH_LIKE = /\/|\.[A-Za-z]{1,5}$/
const SCRIPT_EXTENSION = /\.(sh|py|js|mjs|cjs|ts)$/
const PR_VERBS: Record<string, string> = {
  view: 'Reading PR',
  diff: 'Reading PR',
  checks: 'Checking CI on PR',
  create: 'Opening a PR',
  merge: 'Merging PR',
  comment: 'Commenting on PR',
  review: 'Reviewing PR',
  list: 'Listing PRs',
}
const ISSUE_VERBS: Record<string, string> = {
  view: 'Reading issue',
  create: 'Filing an issue',
  comment: 'Commenting on issue',
  list: 'Listing issues',
}
const GIT_VERBS: Record<string, string> = {
  commit: 'Committing',
  push: 'Pushing',
  diff: 'Checking changes',
  status: 'Checking changes',
  log: 'Checking changes',
  show: 'Checking changes',
  fetch: 'Syncing the branch',
  pull: 'Syncing the branch',
  rebase: 'Syncing the branch',
  merge: 'Syncing the branch',
  checkout: 'Switching branch',
  switch: 'Switching branch',
  add: 'Staging changes',
}
// Pnyx's own sentences are past tense ("Moved"); while it runs the label says "Moving".
const NOW: Record<string, string> = {
  Moved: 'Moving',
  Sent: 'Sending',
  Answered: 'Answering',
  Linked: 'Linking',
  Created: 'Creating',
  Renamed: 'Renaming',
  Updated: 'Updating',
  Cleared: 'Clearing',
  Marked: 'Marking',
  Started: 'Starting',
  Checked: 'Checking',
  Continued: 'Continuing',
  Hid: 'Hiding',
  Brought: 'Bringing',
  Set: 'Setting',
  Queued: 'Queuing',
  Took: 'Taking',
  Denied: 'Denying',
  Allowed: 'Allowing',
  Attached: 'Attaching',
  Detached: 'Detaching',
  Removed: 'Removing',
  Read: 'Reading',
  Listed: 'Listing',
  Saved: 'Saving',
  Forgot: 'Forgetting',
  Stopped: 'Stopping',
  Asked: 'Asking',
}

const base = ({ path }: { path: string }) => path.replace(
  /\/+$/,
  '',
).split('/')
  .at(-1) || path
const fileName = ({ call }: { call: ToolCall }) => call.file ? base({ path: call.file }) : 'a file'
const positional = ({ args }: { args: string[] }) => args.filter(arg => !arg.startsWith('-'))
const lastPath = ({ args }: { args: string[] }) => positional({ args })
  .findLast(arg => PATH_LIKE.test(arg))
const number = ({ args }: { args: string[] }) => args.find(arg => /^\d+$/.test(arg))

const numbered = ({
  words,
  args,
}: {
  words: string
  args: string[]
}) => {
  const found = number({ args })

  return found && !words.endsWith('PRs') && !words.startsWith('Opening') ? `${words} #${found}` : words
}

const searching = ({ query }: { query?: string }) => query && PLAIN_WORD.test(query) ? `Searching for ${query}` : 'Searching the code'
const host = ({ text }: { text: string }) => /https?:\/\/([^/\s"']+)/.exec(text)?.[1]
const reviewing = ({ name }: { name?: string }) => !!name && /review|inspect/i.test(name)

const SKILL_FILE = '/SKILL.md'
const SEARCH_TOOLS = /^(rg|grep|egrep|ag|ack)$/

// A skill read as a file, the way Codex loads one: .../skills/<name>/SKILL.md.
const skillFile = ({ shell }: { shell?: Shell }) => {
  const file = shell && lastPath({ args: shell.args })

  if (!file?.endsWith(SKILL_FILE)) {
    return undefined
  }

  return base({
    path: file.slice(
      0,
      -SKILL_FILE.length,
    ),
  })
}

const searchTerm = ({
  call,
  shell,
}: {
  call: ToolCall
  shell?: Shell
}) => {
  if (call.query || !shell || !SEARCH_TOOLS.test(shell.program)) {
    return call.query
  }

  return positional({ args: shell.args })[0]
}

// Unwraps `sh -c '…'`, leading `cd … &&`, environment assignments and runners, then reads the first command.
export function shellOf({ command }: { command: string }): Shell | undefined {
  let line = command.split('\n')[0]!

  while (LEADING_CD.test(line)) {
    line = line.replace(
      LEADING_CD,
      '',
    )
  }

  let words = shellWords({ command: line })

  for (;;) {
    const first = words[0] ?? ''

    if (RUNNERS.has(first) || /^\w+=/.test(first)) {
      words = words.slice(1)
    } else if (first === 'timeout') {
      words = words.slice(2)
    } else if (PACKAGE_RUNNERS.test(first) && (words[1] === 'exec' || words[1] === 'dlx')) {
      words = words.slice(2)
    } else {
      break
    }
  }

  if (SH_WRAPPER.test(words[0] ?? '') && /^-l?c$/.test(words[1] ?? '') && words[2]) {
    return shellOf({ command: words[2] })
  }

  return words.length ? {
    program: base({ path: words[0]! }),
    args: words.slice(1),
    line: words.join(' '),
  } : undefined
}

// The first matching rule names a call. Add a kind with one more line here and its icon in icon.tsx.
const RULES: Rule[] = [
  {
    icon: 'wait',
    tool: /^(Monitor|ScheduleWakeup|Sleep|TaskOutput|sleep|wait|write_stdin)$/,
    shell: /^(sleep|wait)\b|^lavish-axi poll\b|^(gh|gh-axi) run watch\b/,
    say: () => 'Waiting',
  },
  {
    icon: 'github',
    shell: /^(gh|gh-axi) pr\b/,
    say: ({ shell }) => numbered({
      words: PR_VERBS[positional({ args: shell!.args })[1] ?? ''] ?? 'Working on PR',
      args: shell!.args,
    }),
  },
  {
    icon: 'github',
    shell: /^(gh|gh-axi) issue\b/,
    say: ({ shell }) => numbered({
      words: ISSUE_VERBS[positional({ args: shell!.args })[1] ?? ''] ?? 'Working on issue',
      args: shell!.args,
    }),
  },
  {
    icon: 'github',
    tool: /^mcp__\w*github\w*__/i,
    shell: /^(gh|gh-axi)\b/,
    say: ({ shell }) => shell && /^(gh|gh-axi) run\b/.test(shell.line) ? 'Checking CI' : 'Using GitHub',
  },
  {
    icon: 'search',
    shell: /^git grep\b/,
    say: () => 'Searching the code',
  },
  {
    icon: 'git',
    shell: /^git\b/,
    say: ({ shell }) => GIT_VERBS[positional({ args: shell!.args })[0] ?? ''] ?? 'Using git',
  },
  {
    icon: 'review',
    tool: /^(Skill|Agent|Task)$/,
    shell: /^(no-mistakes|coderabbit)\b|SKILL\.md$/,
    when: ({
      call,
      shell,
    }) => {
      const name = shell ? skillFile({ shell }) : call.skill

      return shell && !name ? true : reviewing({ name })
    },
    say: () => 'Running review',
  },
  {
    icon: 'skill',
    tool: /^Skill$/,
    shell: /SKILL\.md$/,
    say: ({
      call,
      shell,
    }) => `Using ${call.skill ?? skillFile({ shell }) ?? 'a skill'}`,
  },
  {
    icon: 'agent',
    tool: /^(Agent|Task)$/,
    say: () => 'Running a helper',
  },
  {
    icon: 'test',
    shell: /^(pnpm|npm|yarn|bun)( run)? (test|e2e)(:\S+)?\b|^node --test\b|^(vitest|jest|pytest|mocha)\b|^(go|cargo) test\b|^playwright test\b/,
    say: () => 'Running tests',
  },
  {
    icon: 'lint',
    shell: /^(pnpm|npm|yarn|bun)( run)? (lint|typecheck|check|verify|format)(:\S+)?\b|^(eslint|prettier|ruff|biome)\b|^tsc .*--noEmit\b/,
    say: () => 'Running lint',
  },
  {
    icon: 'build',
    shell: /^(pnpm|npm|yarn|bun)( run)? (install|i|add|ci)\b|^pip3? install\b|^brew install\b/,
    say: () => 'Installing packages',
  },
  {
    icon: 'build',
    shell: /^(pnpm|npm|yarn|bun)( run)? build\b|^(vite|tsc|make)\b|^(go|cargo|docker) build\b/,
    say: () => 'Building',
  },
  {
    icon: 'search',
    tool: /^(Grep|Glob)$/,
    shell: /^(rg|grep|egrep|ag|ack|fd|find|ls|tree)\b/,
    say: ({
      call,
      shell,
    }) => {
      if (call.tool === 'Glob' || (shell && /^(ls|tree)$/.test(shell.program))) {
        return 'Looking at files'
      }

      return searching({
        query: searchTerm({
          call,
          shell,
        }),
      })
    },
  },
  {
    icon: 'edit',
    tool: /^(Edit|MultiEdit|NotebookEdit|apply_patch)$/,
    shell: /^(sed|perl) .*-p?i\b/,
    say: ({
      call,
      shell,
    }) => `Editing ${shell ? base({ path: lastPath({ args: shell.args }) ?? 'a file' }) : fileName({ call })}`,
  },
  {
    icon: 'edit',
    tool: /^Write$/,
    say: ({ call }) => `Writing ${fileName({ call })}`,
  },
  {
    icon: 'file',
    tool: /^(Read|view_image)$/,
    shell: /^(cat|sed|head|tail|less|bat|nl|wc|jq)\b/,
    say: ({
      call,
      shell,
    }) => `Reading ${shell ? base({ path: lastPath({ args: shell.args }) ?? 'a file' }) : fileName({ call })}`,
  },
  {
    icon: 'world',
    tool: /^(WebFetch)$/,
    shell: /^(curl|wget|http|open https?:)/,
    say: ({
      call,
      shell,
    }) => `Opening ${host({ text: call.url ?? shell?.line ?? '' }) ?? 'a link'}`,
  },
  {
    icon: 'world',
    tool: /^(WebSearch|web_search|web__\w+)$/,
    say: () => 'Searching the web',
  },
  {
    icon: 'world',
    tool: /^mcp__\w*(playwright|chrome|browser)\w*__/i,
    shell: /^(chrome-devtools-axi|playwright-axi|agent-browser)\b/,
    say: () => 'Using the browser',
  },
  {
    icon: 'plug',
    tool: /^mcp__/,
    say: ({ call }) => {
      const server = call.tool.split('__')[1]!.replace(
        /^(claude_ai_|plugin_[a-z0-9-]+_)/i,
        '',
      )

      return `Using ${server.charAt(0).toUpperCase()}${server.slice(1)}`
    },
  },
]

// A command with no rule: the agent's own words for it, else the program's name.
function fallback({
  call,
  shell,
}: {
  call: ToolCall
  shell?: Shell
}): string {
  if (call.description) {
    return call.description
  }

  if (!shell) {
    return SHELL_TOOLS.test(call.tool) ? 'Running a command' : `Using ${call.tool}`
  }

  if (PLAIN.has(shell.program)) {
    return 'Running a command'
  }

  const script = INTERPRETERS.test(shell.program) && positional({ args: shell.args })
    .find(arg => SCRIPT_EXTENSION.test(arg))

  if (script) {
    return `Running ${base({ path: script })}`
  }

  return `Running ${shell.program.replace(
    SCRIPT_EXTENSION,
    '',
  )}`
}

// Pnyx's past-tense sentence in the present, without the reason or message after a colon.
function pnyxNow({ sentence }: { sentence: Segment[] }): Segment[] {
  const kept: Segment[] = []

  for (const part of sentence) {
    if (typeof part !== 'string') {
      kept.push(part)
      continue
    }

    const before = part.split(': ')[0]!
    const words = kept.length ? before : before.replace(
      /^\w+/,
      verb => NOW[verb] ?? verb,
    )

    if (words) {
      kept.push(words)
    }

    if (before !== part) {
      break
    }
  }

  return kept
}

const shellCall = ({ call }: { call: ToolCall }) => {
  if (!SHELL_TOOLS.test(call.tool) || !call.command) {
    return undefined
  }

  return shellOf({ command: call.command })
}

function callLabel({
  call,
  lookup,
}: {
  call: ToolCall
  lookup: PnyxLookup
}): (ActionLabel & { kind: string }) | undefined {
  if (HIDDEN_TOOLS.test(call.tool)) {
    return undefined
  }

  const shell = shellCall({ call })
  const words = shell && pnyxWords({ command: shell.line })

  if (words) {
    const sentence = pnyxSentence({
      words,
      lookup,
    })

    return {
      kind: 'pnyx',
      icon: 'pnyx',
      sentence: typeof sentence[0] === 'string' && sentence[0].startsWith('Pnyx:') ? ['Using Pnyx'] : pnyxNow({ sentence }),
    }
  }

  const named = ({ rule }: { rule: Rule }) => shell
    ? rule.shell?.test(shell.line)
    : rule.tool?.test(call.tool)
  const rule = RULES.find(candidate => named({ rule: candidate })
    && (candidate.when?.({
      call,
      shell,
    }) ?? true))

  if (!rule) {
    return {
      kind: 'other',
      icon: 'terminal',
      sentence: [
        fallback({
          call,
          shell,
        }),
      ],
    }
  }

  return {
    kind: rule.icon,
    icon: rule.icon,
    sentence: [
      rule.say({
        call,
        shell,
      }),
    ],
  }
}

// Several calls at once: files read or edited together count up, anything else shows the first.
export function actionLabel({
  action,
  lookup,
}: {
  action: CurrentAction
  lookup: PnyxLookup
}): ActionLabel | undefined {
  const labels = action.calls.flatMap(call => callLabel({
    call,
    lookup,
  }) ?? [])
  const first = labels[0]

  if (!first) {
    return undefined
  }

  const together = labels.length > 1 && labels.every(label => label.kind === first.kind)

  if (together && first.kind === 'file') {
    return {
      icon: 'file',
      sentence: [`Reading ${labels.length} files`],
    }
  }

  if (together && first.kind === 'edit') {
    return {
      icon: 'edit',
      sentence: [`Editing ${labels.length} files`],
    }
  }

  return {
    icon: first.icon,
    sentence: first.sentence,
  }
}
