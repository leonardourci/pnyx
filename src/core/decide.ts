import { taskInstructions } from './intent.ts'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { HydraState, SourceRef, Decision } from '../app/model.ts'
import { HydraError } from '../store/errors.ts'
import type { ViewEvent, ViewPreferences } from '../preferences/model.ts'
import { AUTO_TITLE_SOURCES, LINK_KINDS, LINK_STATES, NOTE_KINDS, type AgentRef, type AgentSettings, type Attention, type AutoTitle, type Card, type Column, type Link, type Note, FORM_FIELD_TYPES, type Outcome, type FormField, type PushFields, type Question, type RepliedEvent, type SessionEvent, type TerminalFacts } from './model.ts'
import { TERMINAL_FIELDS } from './route.ts'
import { isStaleLink, isStaleSource, wouldCycle } from './reducer.ts'
import { columnCards, findSession, interactive, liveTask, rankOf } from './tasks.ts'
import { hydraConfig, fallbackColumn, HYDRA_CARD } from './hydra.ts'
import { base, type Meta } from '../app/command-meta.ts'
import { decided } from '../app/decision.ts'
import { invalid, asRecord, onlyKeys, text, optionalText } from '../app/command-validation.ts'
import { projectLabel } from '../projects/labels.ts'

export function findCard({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): Card {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  if (!card) {
    throw new HydraError({
      message: `card not found: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi` to list cards'],
    })
  }

  return card
}

export function strip({ card }: { card: Card | undefined }) {
  if (!card) {
    return undefined
  }

  const content: Partial<Card> = { ...card }
  delete content.revision
  delete content.updatedSeq
  delete content.updatedAt

  return content
}

export function checkRevision({
  card,
  ifRevision,
}: {
  card: Card | undefined
  ifRevision: number | undefined
}): void {
  const revision = card?.revision ?? 0

  if (ifRevision !== undefined && revision !== ifRevision) {
    throw new HydraError({
      message: `card ${card?.id ?? '(new)'} is at revision ${revision}, not ${ifRevision}`,
      code: 'REVISION_CONFLICT',
      help: [card ? `Run \`pnyx-axi card ${card.id}\` and retry with the current revision` : 'Use --if-revision 0 for a new card'],
    })
  }
}

function parseAttention({ value }: { value: unknown }): Attention[] {
  if (!Array.isArray(value)) {
    throw invalid({ message: 'attention must be a list' })
  }

  return value.map((
    rawItem,
    i,
  ) => {
    const item = asRecord({ value: rawItem })

    if (!item) {
      throw invalid({ message: `attention[${i}] must be an object` })
    }

    onlyKeys({
      value: item,
      allowed: [
        'kind',
        'key',
        'blocking',
        'text',
        'questions',
        'form',
        'answered',
      ],
      what: `attention[${i}]`,
    })

    if (item.blocking !== undefined && typeof item.blocking !== 'boolean') {
      throw invalid({ message: `attention[${i}].blocking must be true or false` })
    }

    const note = optionalText({
      value: item.text,
      what: `attention[${i}].text`,
    })
    const answered = optionalText({
      value: item.answered,
      what: `attention[${i}].answered`,
    })

    return {
      kind: text({
        value: item.kind,
        what: `attention[${i}].kind`,
      }),
      key: text({
        value: item.key,
        what: `attention[${i}].key`,
      }),
      blocking: item.blocking === true,
      ...(note ? { text: note } : {}),
      ...(item.questions !== undefined ? {
        questions: parseQuestions({
          value: item.questions,
          what: `attention[${i}].questions`,
        }),
      } : {}),
      ...(item.form !== undefined ? {
        form: parseForm({
          value: item.form,
          what: `attention[${i}].form`,
        }),
      } : {}),
      ...(answered ? { answered } : {}),
    }
  })
}

function parseForm({
  value,
  what,
}: {
  value: unknown
  what: string
}): FormField[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid({ message: `${what} must be a non-empty list` })
  }

  return value.map((
    rawItem,
    i,
  ) => {
    const at = `${what}[${i}]`
    const item = asRecord({ value: rawItem })

    if (!item) {
      throw invalid({ message: `${at} must be an object` })
    }

    onlyKeys({
      value: item,
      allowed: [
        'name',
        'title',
        'type',
        'options',
        'required',
      ],
      what: at,
    })
    const type = FORM_FIELD_TYPES.find(t => t === item.type)

    if (!type) {
      throw invalid({ message: `${at}.type must be one of ${FORM_FIELD_TYPES.join(', ')}` })
    }

    if (item.options !== undefined && (!Array.isArray(item.options) || !item.options.every(o => typeof o === 'string' && o !== ''))) {
      throw invalid({ message: `${at}.options must be a list of strings` })
    }

    const title = optionalText({
      value: item.title,
      what: `${at}.title`,
    })

    return {
      name: text({
        value: item.name,
        what: `${at}.name`,
      }),
      ...(title ? { title } : {}),
      type,
      ...(item.options ? { options: item.options as string[] } : {}),
      ...(item.required === true ? { required: true } : {}),
    }
  })
}

function parseQuestions({
  value,
  what,
}: {
  value: unknown
  what: string
}): Question[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid({ message: `${what} must be a non-empty list` })
  }

  return value.map((
    rawItem,
    i,
  ) => {
    const at = `${what}[${i}]`
    const item = asRecord({ value: rawItem })

    if (!item) {
      throw invalid({ message: `${at} must be an object` })
    }

    onlyKeys({
      value: item,
      allowed: [
        'question',
        'header',
        'options',
        'multiSelect',
      ],
      what: at,
    })

    if (!Array.isArray(item.options)) {
      throw invalid({ message: `${at}.options must be a list` })
    }

    const header = optionalText({
      value: item.header,
      what: `${at}.header`,
    })
    const options = item.options.map((
      rawOption,
      j,
    ) => {
      const option = asRecord({ value: rawOption })

      if (!option) {
        throw invalid({ message: `${at}.options[${j}] must be an object` })
      }

      onlyKeys({
        value: option,
        allowed: [
          'label',
          'description',
        ],
        what: `${at}.options[${j}]`,
      })
      const description = optionalText({
        value: option.description,
        what: `${at}.options[${j}].description`,
      })

      return {
        label: text({
          value: option.label,
          what: `${at}.options[${j}].label`,
        }),
        ...(description ? { description } : {}),
      }
    })

    return {
      question: text({
        value: item.question,
        what: `${at}.question`,
      }),
      ...(header ? { header } : {}),
      options,
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    }
  })
}

function parseSource({ value: rawValue }: { value: unknown }): SourceRef {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'source must be an object' })
  }

  onlyKeys({
    value,
    allowed: [
      'adapter',
      'instanceId',
      'objectId',
      'generation',
      'cursor',
      'observedAt',
    ],
    what: 'source',
  })
  const { generation } = value

  if (generation !== undefined && !(Number.isInteger(generation) && (generation as number) >= 0)) {
    throw invalid({ message: 'source.generation must be a non-negative integer' })
  }

  const source: SourceRef = {
    adapter: text({
      value: value.adapter,
      what: 'source.adapter',
    }),
    objectId: text({
      value: value.objectId,
      what: 'source.objectId',
    }),
  }
  const instanceId = optionalText({
    value: value.instanceId,
    what: 'source.instanceId',
  })
  const cursor = optionalText({
    value: value.cursor,
    what: 'source.cursor',
  })
  const observedAt = optionalText({
    value: value.observedAt,
    what: 'source.observedAt',
  })

  if (instanceId) {
    source.instanceId = instanceId
  }

  if (generation !== undefined) {
    source.generation = generation as number
  }

  if (cursor) {
    source.cursor = cursor
  }

  if (observedAt) {
    source.observedAt = observedAt
  }

  return source
}

function parseAutoTitle({ value: rawValue }: { value: unknown }): AutoTitle {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'autoTitle must be an object' })
  }

  onlyKeys({
    value,
    allowed: [
      'from',
      'text',
    ],
    what: 'autoTitle',
  })

  if (!(AUTO_TITLE_SOURCES as readonly unknown[]).includes(value.from)) {
    throw invalid({ message: `autoTitle.from must be one of ${AUTO_TITLE_SOURCES.join(', ')}` })
  }

  return {
    from: value.from as AutoTitle['from'],
    text: text({
      value: value.text,
      what: 'autoTitle.text',
    }),
  }
}

function parseAgent({ value: rawValue }: { value: unknown }): AgentRef {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'agent must be an object' })
  }

  const fields = [
    'agentId',
    'agentType',
    'cwd',
    'transcriptPath',
    'paseoAgentId',
    'paseoUrl',
    'account',
    'loginFolder',
  ] as const
  onlyKeys({
    value,
    allowed: [
      'provider',
      'sessionId',
      'host',
      'resume',
      ...fields,
    ],
    what: 'agent',
  })
  const agent: AgentRef = {
    provider: text({
      value: value.provider,
      what: 'agent.provider',
    }),
    sessionId: text({
      value: value.sessionId,
      what: 'agent.sessionId',
    }),
  }

  for (const field of fields) {
    const v = optionalText({
      value: value[field],
      what: `agent.${field}`,
    })

    if (v) {
      agent[field] = v
    }
  }

  if (value.host !== undefined) {
    if (value.host !== 'pnyx') {
      throw invalid({ message: 'agent.host must be pnyx' })
    }

    agent.host = 'pnyx'
  }

  if (value.resume !== undefined) {
    if (value.resume !== true) {
      throw invalid({ message: 'agent.resume must be true' })
    }

    agent.resume = true
  }

  return agent
}

// Merges pushed settings into the card's current ones: a string sets a setting and
// null removes it. Returns the card's whole settings after the push, so the event
// replays and undoes on its own.
function mergeSettings({
  current,
  value: rawValue,
}: {
  current: AgentSettings | undefined
  value: unknown
}): AgentSettings | null {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'settings must be an object' })
  }

  const merged = { ...current }

  for (const [
    name,
    v,
  ] of Object.entries(value)) {
    if (!/^[a-z][A-Za-z]{0,31}$/.test(name)) {
      throw invalid({ message: `settings.${name}: a setting name is a camelCase word` })
    }

    if (v === null) {
      delete merged[name]
    } else if (typeof v === 'string' && v.trim() !== '' && v.length <= 200) {
      merged[name] = v
    } else {
      throw invalid({ message: `settings.${name} must be a string of up to 200 characters, or null to remove it` })
    }
  }

  return Object.keys(merged).length ? merged : null
}

function parseTerminal({ value: rawValue }: { value: unknown }): TerminalFacts {
  const value = asRecord({ value: rawValue })

  if (!value) {
    throw invalid({ message: 'terminal must be an object' })
  }

  onlyKeys({
    value,
    allowed: Object.keys(TERMINAL_FIELDS),
    what: 'terminal',
  })

  for (const [
    field,
    v,
  ] of Object.entries(value)) {
    if (typeof v !== 'string' || !TERMINAL_FIELDS[field as keyof TerminalFacts].test(v)) {
      throw invalid({ message: `terminal.${field} has an unsupported value` })
    }
  }

  return value as TerminalFacts
}

// Explicit attachments survive folder changes; Firstmate joins also honor its recorded terminal.
// task is the PNYX_TASK a session was started with: the task it works on, or
// Hydra's own marker; it outranks the folder join for a session not seen yet.
export function joinedKey({
  state,
  key,
  folder,
  terminal,
  probed = false,
  task,
}: {
  state: HydraState
  key: string
  folder: string | undefined
  terminal?: TerminalFacts
  probed?: boolean
  task?: string
}): string {
  const recorded = Object.values(state.sessions ?? {}).find(s => s.sourceRefs.some(r =>
    r.adapter === 'hooks' && `${r.instanceId}:${r.objectId}` === key))

  if (recorded) {
    const task = recorded.taskId ? state.cards[recorded.taskId] : undefined
    const managed = task?.sourceRefs.some(r => r.adapter === 'firstmate')

    const matchesTerminal = !task?.terminal?.paseoTerminal
      || task.terminal.paseoTerminal === terminal?.paseoTerminal

    return task && (!managed || matchesTerminal)
      ? task.key : key
  }

  if (key in state.keys) {
    return key
  }

  const colon = key.indexOf(':')
  const sessionId = key.slice(colon + 1)
  const joined = Object.values(state.cards).find(c => c.sourceRefs.some(r =>
    r.adapter === 'hooks' && r.instanceId === key.slice(
      0,
      colon,
    ) && r.objectId === sessionId))

  const session = terminal?.paseoTerminal
  const hinted = task ? state.cards[task] : undefined

  if (!joined && task === HYDRA_CARD) {
    return key
  }

  if (!joined && hinted && liveTask({ card: hinted }) && !hinted.sessionIds?.length) {
    return hinted.key
  }

  if (joined) {
    return (!joined.agent || joined.agent.sessionId === sessionId)
      && (!joined.terminal?.paseoTerminal || joined.terminal.paseoTerminal === session)
      ? joined.key
      : key
  }

  if (!folder || (probed && !terminal?.tty)) {
    return key
  }

  const tty = terminal?.tty
  const ownTerminal = ({ card: c }: { card: Card }) =>
    !!session && c.terminal?.paseoTerminal === session
  const succeeds = ({ card: c }: { card: Card }) => !!tty
    && (c.activity === 'ended' || !c.terminal?.tty || c.terminal.tty === tty)
  const matches = Object.values(state.cards).filter(c => c.folder === folder
    && (c.agent
      ? ownTerminal({ card: c }) && succeeds({ card: c })
      : !c.terminal?.paseoTerminal || ownTerminal({ card: c })))
  const own = matches.filter(card => ownTerminal({ card }))

  return own.length === 1 ? own[0]!.key : matches.length === 1 ? matches[0]!.key : key
}

export function decideSession({
  state,
  ref,
  task,
  meta,
  fromQueue,
  working,
}: {
  state: HydraState
  ref: string
  task: string | null
  meta: Meta
  fromQueue?: string
  working?: boolean
}): Decision {
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  const session = findSession({
    state,
    ref,
  })
  const target = task === null ? null : findCard({
    state,
    ref: task,
  })
  const current = session.taskId ? state.cards[session.taskId] : state.cards[session.originCardId]
  const card = target ?? current!
  checkRevision({
    card,
    ifRevision: meta.ifRevision,
  })

  if (target?.queue && target.queue.session !== fromQueue) {
    throw new HydraError({
      message: 'unqueue this task before attaching a worker manually',
      code: 'CONFLICT',
    })
  }

  if (target?.sessionIds?.some(id => id !== session.id)) {
    throw new HydraError({
      message: `task ${target.id} already has an attached agent; detach it first`,
      code: 'SESSION_CONFLICT',
    })
  }

  if (target && state.config?.hydra.session === session.id) {
    throw new HydraError({
      message: 'Hydra cannot also be a task worker',
      code: 'CONFLICT',
    })
  }

  if (target && !interactive({ session })) {
    throw new HydraError({
      message: 'A background session has no interactive terminal and cannot be attached to a task',
      code: 'NO_TERMINAL',
    })
  }

  if (session.taskId === (target?.id ?? null)) {
    return { skipped: 'unchanged' }
  }

  const data: SessionEvent['data'] = {
    session: session.id,
    before: session.taskId,
    after: target?.id ?? null,
  }

  if (working) {
    data.working = true
  }

  const instructions = target ? taskInstructions({ card: target }) : ''

  if (instructions) {
    data.brief = instructions
  }

  return {
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'task.session',
      data,
    },
  }
}

export function decidePush({
  state,
  key,
  input: rawInput,
  meta,
  newCardId = `task-${randomUUID()}`,
}: {
  newCardId?: string
  state: HydraState
  key: string
  input: unknown
  meta: Meta
}): Decision {
  text({
    value: key,
    what: 'key',
  })

  const input = asRecord({ value: rawInput })

  if (!input) {
    throw invalid({ message: 'card must be a JSON object' })
  }

  onlyKeys({
    value: input,
    allowed: [
      'title',
      'autoTitle',
      'project',
      'workspace',
      'tags',
      'parent',
      'activity',
      'agent',
      'settings',
      'terminal',
      'folder',
      'attention',
      'source',
    ],
    what: 'card',
  })

  const cardId = state.keys[key] ?? newCardId
  const fields: PushFields = {}
  const title = optionalText({
    value: input.title,
    what: 'title',
  })
  const workspace = optionalText({
    value: input.workspace,
    what: 'workspace',
  })
  const activity = optionalText({
    value: input.activity,
    what: 'activity',
  })
  const folder = input.folder === null ? null : optionalText({
    value: input.folder,
    what: 'folder',
  })

  if (title) {
    fields.title = title
  }

  if (input.project !== undefined) {
    fields.project = projectLabel({ value: input.project })
  }

  if (workspace) {
    fields.workspace = workspace
  }

  if (activity) {
    fields.activity = activity
  }

  if (folder === null) {
    fields.folder = null
  } else if (folder) {
    if (!folder.startsWith('/')) {
      throw invalid({ message: 'folder must be an absolute path' })
    }

    fields.folder = folder
  }

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      throw invalid({ message: 'tags must be a list of strings' })
    }

    fields.tags = [
      ...new Set(input.tags.map((
        t,
        i,
      ) => text({
        value: t,
        what: `tags[${i}]`,
      }))),
    ]
  }

  if (input.autoTitle !== undefined) {
    fields.autoTitle = parseAutoTitle({ value: input.autoTitle })
  }

  if (input.agent !== undefined) {
    fields.agent = parseAgent({ value: input.agent })
  }

  if (input.settings !== undefined) {
    fields.settings = mergeSettings({
      current: state.cards[cardId]?.settings,
      value: input.settings,
    })
  }

  if (input.terminal !== undefined) {
    fields.terminal = parseTerminal({ value: input.terminal })
  }

  if (input.attention !== undefined) {
    fields.attention = parseAttention({ value: input.attention })
  }

  if (input.parent === null) {
    fields.parentId = null
  } else if (input.parent !== undefined) {
    const parent = findCard({
      state,
      ref: text({
        value: input.parent,
        what: 'parent',
      }),
    })

    if (wouldCycle({
      cards: state.cards,
      cardId,
      parentId: parent.id,
    })) {
      throw invalid({ message: `parent ${parent.id} would make a cycle` })
    }

    const hasChildren = Object.values(state.cards).some(c => c.parentId === cardId)

    const declared = state.configured || state.cards[cardId]?.tracking || parent.tracking
    const hookSession = asRecord({ value: input.source })?.adapter === 'hooks' && input.agent

    if (declared && !hookSession && (parent.parentId || hasChildren)) {
      throw invalid({ message: 'subtasks have one level; a subtask cannot have children' })
    }

    fields.parentId = parent.id
  }

  const source = input.source === undefined ? undefined : parseSource({ value: input.source })
  const card = state.cards[cardId]

  if (source && isStaleSource({
    card,
    source,
  })) {
    return { skipped: 'stale' }
  }

  let before: PushFields | undefined

  if (card) {
    const changed = Object.entries(fields)
      .filter(([
        field,
        value,
      ]) => !isDeepStrictEqual(
        pushedValue({
          card,
          field,
        }),
        value,
      ))
    before = Object.fromEntries(
      changed.map(([field]) => [
        field,
        pushedValue({
          card,
          field,
        }),
      ]),
    ) as PushFields
  }

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId,
      }),
      type: 'card.pushed',
      data: {
        key,
        ...fields,
        ...(source ? { source } : {}),
        ...(before ? { before } : {}),
      },
    },
  })
}

// The card's value for a push field, null when absent. An auto title counts as absent.
export function pushedValue({
  card,
  field,
}: {
  card: Card
  field: string
}): unknown {
  if (field === 'title' && !card.titleSet) {
    return null
  }

  return (card as unknown as Record<string, unknown>)[field] ?? null
}

export function checkColumn({
  state,
  column,
}: {
  state: HydraState
  column: Column | null
}): void {
  if (column && !hydraConfig({ state }).columns.some(c => c.id === column)) {
    throw invalid({ message: `unknown Hydra column: ${column}` })
  }
}

export function decideMove(
  {
    state,
    ref,
    column,
    before,
    meta,
  }: {
    state: HydraState
    ref: string
    column: Column
    before?: string
    meta: Meta
  },
): Decision {
  const card = findCard({
    state,
    ref,
  })
  checkColumn({
    state,
    column,
  })
  const others = columnCards({
    state,
    column,
  }).filter(c => c.id !== card.id)
  const above = before === undefined ? undefined : findCard({
    state,
    ref: before,
  }).id
  const at = above === undefined ? others.length : others.findIndex(c => c.id === above)

  if (above === card.id) {
    throw invalid({ message: 'a card cannot go before itself' })
  }

  if (at < 0) {
    throw invalid({ message: `card ${before} is not in column ${column}` })
  }

  const next = others[at], previous = others[at - 1]
  // ponytail: midpoint ranks run out of float precision after ~50 drops into one gap; renumber the column if that ever bites.
  const rank = next && previous ? (rankOf({ card: previous }) + rankOf({ card: next })) / 2
    : next ? rankOf({ card: next }) - 1
      : previous ? rankOf({ card: previous }) + 1 : rankOf({ card })

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.moved',
      data: {
        before: card.column,
        after: column,
        rank,
        beforeRank: rankOf({ card }),
      },
    },
  })
}

export function parseLink({ input }: {
  input: {
    url: string
    kind?: string
    number?: string
    title?: string
    state?: string
    checkedAt?: string
  }
}): Link {
  let url: URL

  try {
    url = new URL(input.url)
  } catch {
    throw invalid({ message: `not a URL: ${input.url}` })
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid({ message: 'link URL must be http or https' })
  }

  const pr = /^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(url.pathname)
  const isGitHubPr = url.hostname === 'github.com' && pr !== null
  const kind = input.kind ?? (isGitHubPr ? 'github_pr' : 'url')

  if (!(LINK_KINDS as readonly string[]).includes(kind)) {
    throw invalid({ message: `kind must be one of ${LINK_KINDS.join(', ')}` })
  }

  if (input.state !== undefined && !(LINK_STATES as readonly string[]).includes(input.state)) {
    throw invalid({ message: `state must be one of ${LINK_STATES.join(', ')}` })
  }

  const number = input.number ?? (isGitHubPr ? pr[1] : undefined)

  if (number !== undefined && !/^\d+$/.test(number)) {
    throw invalid({ message: 'number must be a positive integer' })
  }

  const link: Link = {
    kind: kind as Link['kind'],
    url: input.url,
  }

  if (number !== undefined) {
    link.number = Number(number)
  }

  if (input.title) {
    link.title = input.title
  }

  if (input.state) {
    link.state = input.state as Link['state']
  }

  if (input.checkedAt) {
    link.checkedAt = input.checkedAt
  }

  return link
}

export function decideLink(
  {
    state,
    ref,
    url,
    link,
    meta,
  }: {
    state: HydraState
    ref: string
    url: string
    link: Link | null
    meta: Meta
  },
): Decision {
  const card = findCard({
    state,
    ref,
  })
  const current = card.links.find(l => l.url === url)

  if (!link && !current) {
    return { skipped: 'unchanged' }
  }

  const after = link ? {
    ...current,
    ...link,
  } : null

  if (after && isStaleLink({
    current,
    next: after,
  })) {
    return { skipped: 'stale' }
  }

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.linked',
      data: {
        url,
        before: current ?? null,
        after,
      },
    },
  })
}

// source: the adapter observing this outcome. An observed outcome changes or
// clears only through the same source; a person may replace one hooks observed.
export function decideOutcome(
  {
    state,
    ref,
    outcome,
    meta,
    source,
  }: {
    state: HydraState
    ref: string
    outcome: Outcome | null
    meta: Meta
    source?: string
  },
): Decision {
  const card = findCard({
    state,
    ref,
  })
  const observed = card.outcome?.source

  if (observed && source !== observed && !(source === undefined && observed === 'hooks')) {
    throw new HydraError({
      message: `card ${card.id}'s outcome comes from ${observed} and cannot be changed here`,
      code: 'SOURCE_OWNED',
      help: [`Run \`pnyx-axi move ${card.id} <column>\` to pin the card instead`],
    })
  }

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.outcome',
      data: {
        before: card.outcome ?? null,
        after: outcome && source ? {
          ...outcome,
          source,
        } : outcome,
        card: {
          title: card.title,
          workspace: card.workspace,
          tags: card.tags,
          links: card.links,
        },
      },
    },
  })
}

export function decideReply({
  state,
  ref,
  data,
  meta,
}: {
  state: HydraState
  ref: string
  data: RepliedEvent['data']
  meta: Meta
}): Decision {
  const card = findCard({
    state,
    ref,
  })

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.replied',
      data,
    },
  })
}

// The event id of a harvested note: the same card and source record always give
// the same id, so a note is appended once however often its source is read.
export function noteId({
  cardKey,
  ref,
}: {
  cardKey: string
  ref: string
}): string {
  return `note_${createHash('sha256').update(`${cardKey}\n${ref}`)
    .digest('hex')
    .slice(
      0,
      20,
    )}`
}

export function decideNote(
  {
    state,
    ref,
    note,
    meta,
  }: {
    state: HydraState
    ref: string
    note: Note
    meta: Meta & {
      id: string
    }
  },
): Decision {
  const card = findCard({
    state,
    ref,
  })

  if (!(NOTE_KINDS as readonly string[]).includes(note.kind)) {
    throw invalid({ message: `note kind must be one of ${NOTE_KINDS.join(', ')}` })
  }

  const data: Note = {
    kind: note.kind,
    source: text({
      value: note.source,
      what: 'note source',
    }),
    text: text({
      value: note.text,
      what: 'note text',
    }),
  }

  if (note.at) {
    data.at = note.at
  }

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.noted',
      data,
    },
  })
}

// Cards in a deleted legacy view column move to the fallback column; Hydra columns stay.
export function removedColumnPlacements({
  state,
  after,
}: {
  state: HydraState
  after: ViewPreferences
}): NonNullable<ViewEvent['data']['placements']> {
  const kept = new Set<Column>([
    ...after.customColumns.map(c => c.id),
    ...(state.config?.columns.map(c => c.id) ?? []),
  ])
  const columns = hydraConfig({
    state: {
      ...state,
      view: after,
    },
  }).columns
  const fallback = fallbackColumn({ columns })

  return Object.values(state.cards)
    .filter(c => c.column.startsWith('custom:') && !kept.has(c.column))
    .map(c => ({
      cardId: c.id,
      before: c.column,
      after: fallback,
      revision: c.revision,
    }))
}
