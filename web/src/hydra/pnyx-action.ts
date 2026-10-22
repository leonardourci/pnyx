import type { HydraColumn, HydraState } from '../../../src/core/model.ts'
import { hydraConfig } from '../../../src/core/hydra.ts'
import type { ThreadEntry } from '../../../src/thread/read.ts'

// A sentence about a Pnyx command, with the tasks and columns it touched kept apart so they show as chips.
type Segment = string | {
  task: string
  label: string
} | {
  column: Pick<HydraColumn, 'id' | 'role'>
  label: string
}

export interface PnyxCall {
  command: string
  sentence: Segment[]
  output?: string
  failed?: string
}

export interface PnyxLookup {
  task({ ref }: { ref: string }): {
    id: string
    title: string
  } | undefined
  column({ ref }: { ref: string }): HydraColumn | undefined
}

export function pnyxLookup({ state }: { state: HydraState }): PnyxLookup {
  const columns = hydraConfig({ state }).columns

  return {
    task: ({ ref }) => {
      const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

      return card ? {
        id: card.id,
        title: card.title,
      } : undefined
    },
    column: ({ ref }) => columns.find(column => column.id === ref || column.role === ref
      || column.title.toLowerCase() === ref.toLowerCase()),
  }
}

// Claude's Bash input is {command}; Codex's shell calls carry {cmd} or an argv list.
export function shellCommand({ text }: { text: string }): string | undefined {
  try {
    const input = JSON.parse(text) as {
      command?: unknown
      cmd?: unknown
    }
    const value = input.command ?? input.cmd

    if (typeof value === 'string') {
      return value
    }

    if (Array.isArray(value) && value.every(part => typeof part === 'string')) {
      return value.length === 3 && /(^|\/)(ba|z)?sh$/.test(value[0]) && value[1].startsWith('-') ? value[2] : value.join(' ')
    }
  } catch { /* Not a shell call. */ }

  return undefined
}

// Splits the first command of a shell line into words, following quotes and backslashes.
function shellWords({ command }: { command: string }): string[] {
  const words: string[] = []
  let word = '', quote = '', open = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (quote) {
      if (char === quote) {
        quote = ''
      } else if (char === '\\' && quote === '"' && i + 1 < command.length) {
        word += command[++i]
      } else {
        word += char
      }
    } else if (char === '"' || char === '\'') {
      quote = char; open = true
    } else if (char === '\\' && i + 1 < command.length) {
      word += command[++i]; open = true
    } else if (/\s/.test(char)) {
      if (open) {
        words.push(word); word = ''; open = false
      }
    } else if (';&|'.includes(char)) {
      break
    } else {
      word += char; open = true
    }
  }

  return open ? [
    ...words,
    word,
  ] : words
}

// The words after pnyx-axi, past any environment assignments and runners before it.
export function pnyxWords({ command }: { command: string }): string[] | undefined {
  const words = shellWords({ command })
  const at = words.findIndex(word => /(^|\/)pnyx-axi(\.ts|\.js)?$/.test(word))

  return at >= 0 && words.slice(
    0,
    at,
  ).every(word => /^\w+=/.test(word) || /^(npx|node|pnpm|exec|env)$/.test(word)) ? words.slice(at + 1) : undefined
}

const BOOLEAN = new Set([
  'full',
  'safe',
  'check',
  'discard',
  'preview',
  'remove',
])

function parse({ words }: { words: string[] }) {
  const positionals: string[] = [], flags: Record<string, string> = {}

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!

    if (!word.startsWith('--')) {
      positionals.push(word)
      continue
    }

    const [
      name,
      inline,
    ] = word.slice(2).split(/=(.*)/s)

    if (inline !== undefined) {
      flags[name!] = inline
    } else if (!BOOLEAN.has(name!) && i + 1 < words.length && !words[i + 1]!.startsWith('--')) {
      flags[name!] = words[++i]!
    } else {
      flags[name!] = ''
    }
  }

  return {
    positionals,
    flags,
  }
}

const firstLine = ({ text }: { text: string }) => {
  const line = text.trim().split('\n')[0] ?? ''

  return line.length > 120 ? `${line.slice(
    0,
    119,
  )}…` : line
}

const STATES: Record<string, string> = {
  working: 'working',
  needs_you: 'needs you',
  paused: 'paused',
  blocked: 'blocked',
  done: 'done',
}

// Tool output is plain text, or Claude's list of text blocks.
function toolOutput({ text }: { text: string }): string {
  try {
    const blocks = JSON.parse(text) as unknown

    if (Array.isArray(blocks)) {
      return blocks.map(block => typeof block === 'object' && block && 'text' in block ? String(block.text) : '').join('\n')
    }
  } catch { /* Plain output. */ }

  return text
}

export function pnyxSentence({
  words,
  output = '',
  lookup,
}: {
  words: string[]
  output?: string
  lookup: PnyxLookup
}): Segment[] {
  const {
    positionals,
    flags,
  } = parse({ words })
  const [
    area,
    action,
  ] = positionals

  const task = ({ ref = '' }: { ref?: string }): Segment => {
    const found = lookup.task({ ref })

    return {
      task: found?.id ?? ref,
      label: found?.title ?? ref,
    }
  }

  const because = flags.reason ? `: ${flags.reason}` : ''
  const created = /^\s*id: (task-[\w-]+)/m.exec(output)?.[1]
  const confirming = /^confirmation: needed$/m.test(output)

  switch (area) {
    case 'move': {
      const found = lookup.column({ ref: positionals[2] ?? '' })
      const column: Segment = found ? {
        column: {
          id: found.id,
          role: found.role,
        },
        label: found.title,
      } : positionals[2] ?? 'a column'

      return [
        confirming ? 'Asked to confirm moving ' : 'Moved ',
        task({ ref: positionals[1] ?? '' }),
        ' to ',
        column,
        confirming ? '' : because,
      ].filter(Boolean)
    }
    case 'reply':
      return flags.answer !== undefined ? [
        'Answered the question from ',
        task({ ref: action }),
      ] : [
        'Sent ',
        task({ ref: action }),
        `’s worker: ${firstLine({ text: flags.text ?? '' })}`,
      ]
    case 'link':
      return [
        'Linked ',
        task({ ref: action }),
        ` to ${flags.url ?? 'a link'}`,
      ]
    case 'task': {
      const target = task({ ref: positionals[2] })

      switch (action) {
        case 'create':
          return [
            'Created ',
            created ? {
              task: lookup.task({ ref: created })?.id ?? created,
              label: lookup.task({ ref: created })?.title ?? flags.title ?? created,
            } : `“${flags.title ?? 'a task'}”`,
            because,
          ]
        case 'rename': return [
          'Renamed ',
          target,
          ` to “${flags.title ?? ''}”`,
        ]
        case 'brief': return [
          flags.brief ? 'Updated the brief of ' : 'Cleared the brief of ',
          target,
          because,
        ]
        case 'status': return [
          'Marked ',
          target,
          ` ${STATES[positionals[3] ?? ''] ?? positionals[3] ?? ''}${flags.note ? `: ${firstLine({ text: flags.note })}` : ''}`,
        ]
        case 'start': return [
          'Started a worker on ',
          target,
          `${flags.harness ? ` with ${flags.harness === 'codex' ? 'Codex' : 'Claude Code'}` : ''}${because}`,
        ]
        case 'continue': return flags.check !== undefined ? [
          'Checked whether the agent of ',
          target,
          ' can continue',
        ] : [
          'Continued the agent of ',
          target,
        ]
        case 'hide': return [
          'Hid ',
          target,
          because,
        ]
        case 'unhide': return [
          'Brought back ',
          target,
        ]
        case 'remind': return positionals[3] === 'clear' ? [
          'Cleared the reminder on ',
          target,
        ] : [
          'Set a reminder on ',
          target,
          ` for ${positionals[3] ?? 'later'}${because}`,
        ]
        case 'queue': return [
          'Queued ',
          target,
          ' behind ',
          task({ ref: flags.behind }),
        ]
        case 'unqueue': return [
          'Took ',
          target,
          ' out of the queue',
        ]
        case 'permission': return [
          positionals[4] === 'deny' ? 'Denied the request from ' : 'Allowed the request from ',
          target,
          because,
        ]
        case 'attach': return [
          'Attached a session to ',
          target,
        ]
        case 'detach': return [
          'Detached the agent from ',
          target,
        ]
        case 'copy': return positionals[3] === 'remove' ? [
          'Removed the copy of ',
          target,
        ] : [
          'Checked the copy of ',
          target,
        ]
        case 'show': return [
          'Read ',
          target,
        ]
        case 'history': return [
          'Read the history of ',
          target,
        ]
        case 'list': return ['Listed the tasks']
      }

      break
    }
    case 'hydra':
      switch (action) {
        case 'check': return ['Checked what changed']
        case 'digest': return ['Read the Hydra']
        case 'messages': return ['Read the messages']
        case 'stop': return ['Stopped Hydra’s turn']
        case 'send': return flags.task ? [
          'Sent a message about ',
          task({ ref: flags.task }),
          `: ${firstLine({ text: flags.text ?? '' })}`,
        ] : [`Sent a message: ${firstLine({ text: flags.text ?? '' })}`]
        case 'memory': return [
          memory({
            layer: 'Hydra',
            action: positionals[2],
            key: flags.key,
          }),
        ]
      }

      break
    case 'owner':
      return [
        memory({
          layer: 'owner',
          action: positionals[2],
          key: flags.key,
        }),
      ]
    case 'project':
      if (action === 'memory') {
        return [
          memory({
            layer: 'project',
            action: positionals[2],
            key: flags.key,
          }),
        ]
      }

      if (action === 'show' || action === 'list') {
        return [action === 'list' ? 'Listed the projects' : `Read project ${positionals[2] ?? ''}`]
      }

      break
  }

  return [
    `Pnyx: ${positionals.slice(
      0,
      2,
    ).join(' ') || 'help'}`,
  ]
}

const MEMORY_VERBS: Record<string, string> = {
  set: 'Saved',
  forget: 'Forgot',
}

const memory = ({
  layer,
  action = 'list',
  key,
}: {
  layer: string
  action?: string
  key?: string
}) => MEMORY_VERBS[action] ? `${MEMORY_VERBS[action]} ${layer} memory “${key ?? ''}”` : `Read ${layer} memory`

// TOON quotes a value only when it has to.
const unquote = ({ text }: { text: string }) => {
  try {
    return text.startsWith('"') ? String(JSON.parse(text)) : text
  } catch {
    return text
  }
}

const errorOf = ({ output }: { output: string }) => {
  const line = /^error: (.*)$/m.exec(output)?.[1]

  return line === undefined ? undefined : unquote({ text: line })
}

// Pnyx command rows absorb their results, and the chat line a command posted is not repeated.
export function pnyxCalls<Entry extends ThreadEntry>({
  entries,
  lookup,
}: {
  entries: Entry[]
  lookup: PnyxLookup
}): {
  entries: Entry[]
  calls: Map<string, PnyxCall>
} {
  const found = new Map<string, {
    entry: ThreadEntry
    command: string
    words: string[]
  }>()

  for (const entry of entries) {
    const command = entry.kind === 'tool' && entry.call ? shellCommand({ text: entry.text }) : undefined
    const words = command === undefined ? undefined : pnyxWords({ command })

    if (words && entry.call && !found.has(entry.call)) {
      found.set(
        entry.call,
        {
          entry,
          command: command!,
          words,
        },
      )
    }
  }

  const outputs = new Map<string, string>(), posted = new Set<string>()

  const result = ({ entry }: { entry: ThreadEntry }) => {
    const call = entry.call ? found.get(entry.call) : undefined

    return call && call.entry !== entry ? call : undefined
  }

  for (const entry of entries) {
    const call = result({ entry })

    if (call) {
      const output = toolOutput({ text: entry.text })
      const line = /^posted: (.*)$/m.exec(output)?.[1]
      outputs.set(
        call.entry.id,
        output,
      )

      if (line) {
        posted.add(unquote({ text: line }).trim())
      }
    }
  }

  // A confirmation request says nothing new once the confirmed command follows it.
  const unconfirmed = ({ words }: { words: string[] }) => words.filter((
    word,
    index,
  ) => word !== '--confirm' && words[index - 1] !== '--confirm').join(' ')
  const confirmed = new Set([...found.values()].filter(call => call.words.includes('--confirm'))
    .map(call => unconfirmed(call)))
  const superseded = new Set([...found.values()].filter(call => !call.words.includes('--confirm')
    && /^confirmation: needed$/m.test(outputs.get(call.entry.id) ?? '') && confirmed.has(unconfirmed(call)))
    .map(call => call.entry))
  const kept = entries.filter(entry => !result({ entry }) && !superseded.has(entry)
    && !(entry.kind === 'message' && entry.role.startsWith('assistant') && posted.has(entry.text.trim())))

  return {
    entries: kept,
    calls: new Map([...found.values()].map(({
      entry,
      command,
      words,
    }) => {
      const output = outputs.get(entry.id)

      return [
        entry.id,
        {
          command,
          sentence: pnyxSentence({
            words,
            output,
            lookup,
          }),
          output,
          failed: output === undefined ? undefined : errorOf({ output }),
        },
      ]
    })),
  }
}
