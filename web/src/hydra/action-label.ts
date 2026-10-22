import { SHELL_WRAPPER, type CurrentAction, type ToolCall } from '../../../src/thread/calls.ts'
import { pnyxSentence, pnyxWords, shellWords, UNKNOWN_COMMAND, type PnyxLookup, type Segment } from './pnyx-action.ts'

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

// args is the shell line's words after the program, empty for a tool call.
interface RuleInput {
  call: ToolCall
  shell?: Shell
  args: string[]
}

interface Rule {
  icon: string
  tool?: RegExp
  shell?: RegExp
  // A further check on what the call names, such as the skill a review runs.
  when?({
    call,
    shell,
    args,
  }: RuleInput): boolean
  say({
    call,
    shell,
    args,
  }: RuleInput): string
}

const SHELL_TOOLS = /^(Bash|exec_command|shell|local_shell|container\.exec)$/
// Bookkeeping, not work: these leave the label as it was.
const HIDDEN_TOOLS = /^(ToolSearch|TodoWrite|Task(Create|Update|List|Get)|AskUserQuestion|EnterPlanMode|ExitPlanMode|update_plan|request_user_input\w*)$/
const LEADING_CD = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/
// Words that only run the real command: `rtk proxy git …`, `npx -y vitest`.
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
// timeout's options that take a value, as in `timeout -s KILL 30 …`.
const TIMEOUT_VALUE_OPTIONS = new Set([
  '-s',
  '-k',
  '--signal',
  '--kill-after',
])
const PACKAGE_RUNNERS = /^(pnpm|yarn|npm|bun)$/
const INTERPRETERS = /^(python3?|node|bash|sh|zsh|tsx|ts-node|deno|ruby|perl|bun)$/
const SEARCH_PROGRAMS = /^(rg|grep|egrep|ag|ack)$/
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
const SKILL_FILE = '/SKILL.md'
const A_FILE = 'a file'
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
// Verbs whose next word, when it is a number, names one PR or issue.
const NUMBERED_VERBS = new Set([
  'view',
  'diff',
  'checks',
  'merge',
  'comment',
  'review',
])
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
// Calls of one of these kinds made together read as a count: "Reading 3 files".
const COUNTED_VERBS: Record<string, string> = {
  file: 'Reading',
  edit: 'Editing',
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
// A call made before the turn began belongs to the last turn; the slack covers clocks of different processes.
const TURN_SLACK_MS = 5000

const lastSegment = ({ path }: { path: string }) => {
  const trimmed = path.replace(
    /\/+$/,
    '',
  )

  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

const positional = ({ args }: { args: string[] }) => args.filter(arg => !arg.startsWith('-'))
const lastPath = ({ args }: { args: string[] }) => positional({ args })
  .findLast(arg => PATH_LIKE.test(arg))

const fileOf = ({
  call,
  shell,
  args,
}: RuleInput) => {
  const path = shell ? lastPath({ args }) : call.file

  if (!path) {
    return A_FILE
  }

  return lastSegment({ path })
}

// `gh pr view 4728` → "Reading PR #4728"; the number counts only right after the verb.
const githubWords = ({
  args,
  verbs,
  otherwise,
}: {
  args: string[]
  verbs: Record<string, string>
  otherwise: string
}) => {
  const verb = args[1] ?? ''
  const words = verbs[verb] ?? otherwise
  const target = args[2] ?? ''

  if (!NUMBERED_VERBS.has(verb) || !/^\d+$/.test(target)) {
    return words
  }

  return `${words} #${target}`
}

const searching = ({ query }: { query?: string }) => {
  if (!query || !PLAIN_WORD.test(query)) {
    return 'Searching the code'
  }

  return `Searching for ${query}`
}

const searchTerm = ({
  call,
  shell,
  args,
}: RuleInput) => {
  if (!shell || !SEARCH_PROGRAMS.test(shell.program)) {
    return call.query
  }

  return positional({ args })[0]
}

const hostOf = ({ text }: { text: string }) => /https?:\/\/([^/\s"']+)/.exec(text)?.[1]
const namesReview = ({ name }: { name?: string }) => !!name && /review|inspect/i.test(name)

// A skill read as a file, the way Codex loads one: .../skills/<name>/SKILL.md.
const skillFile = ({ args }: { args: string[] }) => {
  const file = lastPath({ args })

  if (!file?.endsWith(SKILL_FILE)) {
    return undefined
  }

  return lastSegment({
    path: file.slice(
      0,
      -SKILL_FILE.length,
    ),
  })
}

function withoutRunners({ words }: { words: string[] }): string[] {
  let rest = words

  while (rest.length) {
    const [
      first = '',
      second = '',
    ] = rest

    if (RUNNERS.has(first) || /^\w+=/.test(first)) {
      rest = rest.slice(1)
    } else if (first === 'timeout') {
      rest = rest.slice(1)

      while (rest[0]?.startsWith('-')) {
        rest = rest.slice(TIMEOUT_VALUE_OPTIONS.has(rest[0]) ? 2 : 1)
      }

      // The duration.
      rest = rest.slice(1)
    } else if (PACKAGE_RUNNERS.test(first) && (second === 'exec' || second === 'dlx')) {
      rest = rest.slice(2)
    } else {
      return rest
    }
  }

  return rest
}

// Only the first command names the work: `cd x && pnpm test | tail` is "Running tests".
export function shellOf({ command }: { command: string }): Shell | undefined {
  let line = command.split('\n')[0]!

  while (LEADING_CD.test(line)) {
    line = line.replace(
      LEADING_CD,
      '',
    )
  }

  const words = withoutRunners({ words: shellWords({ command: line }) })
  const [
    program,
    flag = '',
    script,
  ] = words

  if (!program) {
    return undefined
  }

  if (SHELL_WRAPPER.test(program) && /^-l?c$/.test(flag) && script) {
    return shellOf({ command: script })
  }

  let args = words.slice(1)

  // `git -C <dir>` and `pnpm -C <dir>` name a folder, not the work.
  while (args[0] === '-C' && args.length > 1) {
    args = args.slice(2)
  }

  const name = lastSegment({ path: program })

  return {
    program: name,
    args,
    line: [
      name,
      ...args,
    ].join(' '),
  }
}

// The first matching rule names a call. A new kind is one more entry here and its icon in icon.tsx.
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
    say: ({ args }) => githubWords({
      args,
      verbs: PR_VERBS,
      otherwise: 'Working on PR',
    }),
  },
  {
    icon: 'github',
    shell: /^(gh|gh-axi) issue\b/,
    say: ({ args }) => githubWords({
      args,
      verbs: ISSUE_VERBS,
      otherwise: 'Working on issue',
    }),
  },
  {
    icon: 'github',
    shell: /^(gh|gh-axi) run\b/,
    say: () => 'Checking CI',
  },
  {
    icon: 'github',
    tool: /^mcp__\w*github\w*__/i,
    shell: /^(gh|gh-axi)\b/,
    say: () => 'Using GitHub',
  },
  {
    icon: 'search',
    shell: /^git grep\b/,
    say: () => 'Searching the code',
  },
  {
    icon: 'git',
    shell: /^git\b/,
    say: ({ args }) => GIT_VERBS[positional({ args })[0] ?? ''] ?? 'Using git',
  },
  {
    icon: 'review',
    tool: /^(Skill|Agent|Task)$/,
    shell: /^(no-mistakes|coderabbit)\b|SKILL\.md$/,
    when: ({
      call,
      shell,
      args,
    }) => {
      if (!shell) {
        return namesReview({ name: call.skill })
      }

      const skill = skillFile({ args })

      return skill === undefined || namesReview({ name: skill })
    },
    say: () => 'Running review',
  },
  {
    icon: 'skill',
    tool: /^Skill$/,
    shell: /SKILL\.md$/,
    say: ({
      call,
      args,
    }) => `Using ${call.skill ?? skillFile({ args }) ?? 'a skill'}`,
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
    tool: /^Glob$/,
    shell: /^(ls|tree)\b/,
    say: () => 'Looking at files',
  },
  {
    icon: 'search',
    tool: /^Grep$/,
    shell: /^(rg|grep|egrep|ag|ack|fd|find)\b/,
    say: ({
      call,
      shell,
      args,
    }) => searching({
      query: searchTerm({
        call,
        shell,
        args,
      }),
    }),
  },
  {
    icon: 'edit',
    tool: /^(Edit|MultiEdit|NotebookEdit|apply_patch)$/,
    shell: /^(sed|perl) .*-p?i\b/,
    say: ({
      call,
      shell,
      args,
    }) => `Editing ${fileOf({
      call,
      shell,
      args,
    })}`,
  },
  {
    icon: 'edit',
    tool: /^Write$/,
    say: ({
      call,
      shell,
      args,
    }) => `Writing ${fileOf({
      call,
      shell,
      args,
    })}`,
  },
  {
    icon: 'file',
    tool: /^(Read|view_image)$/,
    shell: /^(cat|sed|head|tail|less|bat|nl|wc|jq)\b/,
    say: ({
      call,
      shell,
      args,
    }) => `Reading ${fileOf({
      call,
      shell,
      args,
    })}`,
  },
  {
    icon: 'world',
    tool: /^WebFetch$/,
    shell: /^(curl|wget|http|open https?:)/,
    say: ({
      call,
      shell,
    }) => `Opening ${hostOf({ text: call.url ?? shell?.line ?? '' }) ?? 'a link'}`,
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

function ruleFor({ input }: { input: RuleInput }): Rule | undefined {
  for (const rule of RULES) {
    const pattern = input.shell ? rule.shell : rule.tool
    const named = pattern?.test(input.shell ? input.shell.line : input.call.tool)

    if (!named) {
      continue
    }

    if (!rule.when || rule.when(input)) {
      return rule
    }
  }

  return undefined
}

// A command with no rule: the agent's own words for it, else the program's name.
function fallback({
  call,
  shell,
  args,
}: RuleInput): string {
  if (call.description) {
    return call.description
  }

  if (!shell) {
    return SHELL_TOOLS.test(call.tool) ? 'Running a command' : `Using ${call.tool}`
  }

  if (PLAIN.has(shell.program)) {
    return 'Running a command'
  }

  if (INTERPRETERS.test(shell.program)) {
    const script = positional({ args }).find(arg => SCRIPT_EXTENSION.test(arg))

    if (script) {
      return `Running ${lastSegment({ path: script })}`
    }
  }

  return `Running ${shell.program.replace(
    SCRIPT_EXTENSION,
    '',
  )}`
}

// Pnyx's sentence without the reason or message after a colon.
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
}): ActionLabel | undefined {
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
    const known = !(typeof sentence[0] === 'string' && sentence[0].startsWith(UNKNOWN_COMMAND))

    return {
      icon: 'pnyx',
      sentence: known ? pnyxNow({ sentence }) : ['Using Pnyx'],
    }
  }

  const input: RuleInput = {
    call,
    shell,
    args: shell?.args ?? [],
  }
  const rule = ruleFor({ input })

  if (!rule) {
    return {
      icon: 'terminal',
      sentence: [fallback(input)],
    }
  }

  return {
    icon: rule.icon,
    sentence: [rule.say(input)],
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
  const labels = action.calls
    .map(call => callLabel({
      call,
      lookup,
    }))
    .filter(label => label !== undefined)
  const first = labels[0]

  if (!first) {
    return undefined
  }

  const verb = COUNTED_VERBS[first.icon]
  const together = labels.length > 1 && labels.every(label => label.icon === first.icon)

  if (verb && together) {
    return {
      icon: first.icon,
      sentence: [`${verb} ${labels.length} files`],
    }
  }

  return first
}

const fromEarlierTurn = ({
  action,
  since,
}: {
  action: CurrentAction
  since?: string | null
}) => {
  if (!since || !action.at) {
    return false
  }

  return Date.parse(action.at) < Date.parse(since) - TURN_SLACK_MS
}

// null when nothing is running this turn; undefined when only bookkeeping calls are, which keeps the label shown.
export function currentLabel({
  action,
  since,
  lookup,
}: {
  action?: CurrentAction
  since?: string | null
  lookup: PnyxLookup
}): ActionLabel | null | undefined {
  if (!action || fromEarlierTurn({
    action,
    since,
  })) {
    return null
  }

  return actionLabel({
    action,
    lookup,
  })
}
