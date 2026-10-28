import type { SourceRef, HydraState, Decision } from '#app/model.ts'
import { asRecord, invalid, onlyKeys, text, optionalText } from '#app/command-validation.ts'
import type { AgentRef, AgentSettings, TerminalFacts, SessionEvent } from './model.ts'
import { TERMINAL_FIELDS } from './reply-route.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { findSession, interactive } from './session-attachments.ts'
import { findCard, checkRevision } from '#tasks/push-rules.ts'
import { HydraError } from '#store/errors.ts'
import { taskInstructions } from '#tasks/intent.ts'

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
