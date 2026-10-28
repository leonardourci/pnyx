import { taskInstructions } from '../tasks/intent.ts'
import type { HydraState, SourceRef, Decision } from '../app/model.ts'
import { HydraError } from '../store/errors.ts'
import type { RepliedEvent } from '../tasks/model.ts'
import { LINK_KINDS, LINK_STATES, type AgentRef, type AgentSettings, type Link, type Outcome, type SessionEvent, type TerminalFacts } from './model.ts'
import { TERMINAL_FIELDS } from './route.ts'
import { isStaleLink } from './reducer.ts'
import { findSession, interactive } from './tasks.ts'
import { base, type Meta } from '../app/command-meta.ts'
import { decided } from '../app/decision.ts'
import { invalid, asRecord, onlyKeys, text, optionalText } from '../app/command-validation.ts'
import { findCard, checkRevision } from '../tasks/push-rules.ts'

export function parseSource({ value: rawValue }: { value: unknown }): SourceRef {
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

export function parseAgent({ value: rawValue }: { value: unknown }): AgentRef {
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
export function mergeSettings({
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

export function parseTerminal({ value: rawValue }: { value: unknown }): TerminalFacts {
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
