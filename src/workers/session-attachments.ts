import { HYDRA_CARD } from '#hydra/identity.ts'
import { cloneValue } from '#app/preimage.ts'
import type { AgentRef, AgentSession, Attention, TerminalFacts } from './model.ts'
import type { Card } from '#tasks/model.ts'
import type { HydraState, HydraEvent } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import { touch } from '#tasks/touch.ts'

// The open request marking a hosted agent's turn cut off by a server stop; it belongs
// to that agent, so it goes when the agent leaves the task.
export const INTERRUPTED = 'pnyx:interrupted'

// New work for an agent clears the marker its cut turn left.
export const withoutInterrupted = ({ attention }: { attention: Attention[] }) =>
  attention.filter(a => a.key !== INTERRUPTED)

export function sessionId({ agent }: { agent: AgentRef }): string {
  return `${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}`
}

export function interactive({ session }: { session: AgentSession }): boolean {
  return Boolean(session.terminal?.tty || session.agent.host)
}

export function cardSessionId({ card }: { card: Card }): string | undefined {
  return card.sessionIds?.[0] ?? (card.agent ? sessionId({ agent: card.agent }) : undefined)
}

export function sessionByRef({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): AgentSession | undefined {
  const direct = state.sessions?.[ref]
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  return direct ?? Object.values(state.sessions ?? {}).find(s =>
    card?.sessionIds?.includes(s.id) || s.sourceRefs.some(r => `${r.instanceId}:${r.objectId}` === ref))
}

export function findSession({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): AgentSession {
  const found = sessionByRef({
    state,
    ref,
  })

  if (!found) {
    throw new HydraError({
      message: `session not found: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi task sessions`'],
    })
  }

  return found
}

export function selfSession({
  state,
  here,
}: {
  state: HydraState
  here: Pick<TerminalFacts, 'tmuxPane' | 'herdrPane'>
}): AgentSession {
  const keys = ([
    'tmuxPane',
    'herdrPane',
  ] as const).filter(k => here[k])
  const rank = ({ s }: { s: AgentSession }) => (s.activity === 'ended' ? 0 : 1e12)
    + (state.cards[s.taskId ?? s.originCardId]?.updatedSeq ?? 0)
  const found = Object.values(state.sessions ?? {})
    .filter(s => keys.some(k => s.terminal?.[k] === here[k]))
    .sort((
      a,
      b,
    ) => rank({ s: b }) - rank({ s: a }))[0]

  if (!found) {
    throw new HydraError({
      message: keys.length ? 'no recorded session runs in this terminal' : 'cannot tell this terminal: no tmux or Herdr pane in the environment',
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi task sessions` and pass --session <id>'],
    })
  }

  return found
}

// An absent value deletes its key, so the state keeps its shape through its saved JSON.
export function assignDefined<T extends object>({
  target,
  values,
}: {
  target: T
  values: Partial<T>
}): void {
  for (const [
    key,
    value,
  ] of Object.entries(values)) {
    if (value === undefined) {
      delete (target as Record<string, unknown>)[key]
    } else {
      (target as Record<string, unknown>)[key] = value
    }
  }
}

export function sessionTask({
  state,
  agent,
}: {
  state: HydraState
  agent: AgentRef
}): Card | undefined {
  const id = sessionId({ agent })
  const parent = sessionId({
    agent: {
      provider: agent.provider,
      sessionId: agent.sessionId,
    },
  })
  const root = state.sessions?.[parent]
  const task = agent.agentId ? root?.taskId : state.sessions?.[id]?.taskId

  if (task) {
    return state.cards[task]
  }

  return state.config?.hydra.session === parent ? state.cards[HYDRA_CARD] : undefined
}

export function projectedAttention({
  agent,
  attention,
}: {
  agent: AgentRef
  attention: Attention[]
}): Attention[] {
  return attention.map(item => ({
    ...item,
    key: agent.agentId ? `hook:child:${sessionId({ agent })}:${item.key}` : item.key,
  }))
}

export function observedQuestions({ event }: { event: HydraEvent }): Attention[] {
  let attention: Attention[] | undefined

  if (event.type === 'session.observed') {
    attention = 'fields' in event.data ? event.data.fields.attention : event.data.attention
  } else if (event.type === 'card.pushed') {
    attention = event.data.attention
  }

  return attention?.filter(item => item.blocking && !item.answered) ?? []
}

export function sessionAttention({
  state,
  session,
}: {
  state: HydraState
  session: AgentSession
}): Attention[] {
  const children = Object.values(state.sessions ?? {}).filter(child => child.agent.agentId
    && child.agent.provider === session.agent.provider
    && child.agent.sessionId === session.agent.sessionId
    && (child.sessionActivity ?? child.activity) !== 'ended')

  return [
    ...session.attention,
    ...children.flatMap(child => projectedAttention({
      agent: child.agent,
      attention: child.attention,
    })),
  ]
}

// Membership projection preserves task-owned fields when the session changes.
export function projectSession({
  state,
  session,
}: {
  state: HydraState
  session: AgentSession
}): void {
  if (session.agent.agentId) {
    const parent = state.sessions?.[sessionId({
      agent: {
        provider: session.agent.provider,
        sessionId: session.agent.sessionId,
      },
    })]

    if (parent) {
      projectSession({
        state,
        session: parent,
      })
    }

    return
  }

  const task = sessionTask({
    state,
    agent: session.agent,
  })

  if (!task) {
    return
  }

  task.sessionIds = [session.id]
  task.agent = cloneValue({ value: session.agent })
  task.launch = session.launch && cloneValue({ value: session.launch })
  task.sourceRefs = [
    ...task.sourceRefs.filter(r => !session.sourceRefs.some(s =>
      r.adapter === s.adapter && r.instanceId === s.instanceId && r.objectId === s.objectId)),
    ...session.sourceRefs,
  ]
  assignDefined({
    target: task,
    values: {
      settings: session.settings && { ...session.settings },
      terminal: session.terminal && { ...session.terminal },
      activity: session.activity,
      sessionActivity: session.sessionActivity,
      workingSince: session.workingSince,
      turnStartedAt: session.turnStartedAt,
      turnEndedSeq: session.turnEndedSeq,
      stoppedAt: session.stoppedAt,
    },
  })
  task.attention = [
    ...task.attention.filter(a => !a.key.startsWith('hook:')),
    ...sessionAttention({
      state,
      session,
    }),
  ]

  if (!task.outcome || task.outcome.source === 'hooks') {
    if (session.outcome) {
      task.outcome = { ...session.outcome }
    } else {
      delete task.outcome
    }
  }
}

export function applyAttachment({
  state,
  event,
}: {
  state: HydraState
  event: Extract<HydraEvent, { type: 'task.session'}>
}): boolean {
  let session = state.sessions?.[event.data.session]
  const started = event.data.started
  const destination = event.data.after
  const target = destination === null ? undefined : state.cards[destination]

  if (destination !== null && !target) {
    return false
  }

  if (target && target.id !== event.data.before && cardSessionId({ card: target })) {
    return false
  }

  if (started) {
    if (session || event.data.before !== null || !target) {
      return false
    }

    session = {
      id: event.data.session,
      agent: cloneValue({ value: started.agent }),
      settings: cloneValue({ value: started.settings }),
      originCardId: event.cardId,
      launchId: event.id,
      taskId: null,
      launch: {
        via: 'pnyx',
        at: event.at,
        folder: started.agent.cwd,
        harness: started.agent.provider,
      },
      lastSeen: event.at,
      activity: 'working',
      sessionActivity: 'working',
      workingSince: event.at,
      attention: [],
      sourceRefs: [],
    }

    if (!state.sessions) {
      state.sessions = {}
    }

    state.sessions[session.id] = session
  }

  if (!session || session.taskId !== event.data.before) {
    return false
  }

  const old = session.taskId && state.cards[session.taskId]

  if (old) {
    old.sessionIds = []
    delete old.agent
    delete old.settings
    delete old.terminal
    delete old.activity
    delete old.sessionActivity
    delete old.turnStartedAt
    delete old.turnEndedSeq
    delete old.workingSince
    delete old.stoppedAt
    old.attention = old.attention.filter(a => !a.key.startsWith('hook:') && a.key !== INTERRUPTED)

    if (old.outcome?.source === 'hooks') {
      delete old.outcome
    }

    touch({
      card: old,
      event,
    })
  }

  if (target && target.launch?.via === 'command' && session.launch?.via === 'hooks') {
    session.launch = {
      ...target.launch,
      harness: session.agent.provider,
    }
  }

  const handoff = event.data.handoff

  if (target && handoff) {
    delete target.queue
    delete target.queueNote
    target.folder = handoff.folder
    target.column = handoff.column
    session.queueCompleted = (session.queueCompleted ?? 0) + 1

    if (handoff.copy) {
      target.copy = cloneValue({ value: handoff.copy })

      if (old && old.copy) {
        old.copy = {
          ...old.copy,
          state: 'removed',
          reason: `handed to ${target.id}`,
        }
      }
    }
  }

  session.taskId = event.data.after
  projectSession({
    state,
    session,
  })

  return true
}

// Replay migrates legacy observations without changing event bytes or ids.
export function observeSession({
  state,
  card,
  event,
}: {
  state: HydraState
  card: Card
  event: HydraEvent
}): void {
  if (!card.agent || event.type === 'task.session') {
    return
  }

  const id = sessionId({ agent: card.agent })
  state.sessions ??= {}
  const session = state.sessions[id] ??= {
    id,
    agent: cloneValue({ value: card.agent }),
    originCardId: card.id,
    taskId: card.agent.agentId || (card.sessionIds?.length && !card.sessionIds.includes(id))
      ? null : card.id,
    attention: [],
    sourceRefs: [],
  }

  if (event.type === 'card.pushed' || event.type === 'card.observed') {
    const pushedAgent = event.type === 'card.pushed' ? event.data.agent : undefined

    if (pushedAgent?.host === 'pnyx' && session.launch?.via !== 'pnyx') {
      session.launch = {
        via: 'pnyx',
        at: event.at,
        folder: card.agent.cwd,
        harness: card.agent.provider,
      }
    }

    if (!session.launch) {
      // Copies, not the card's own objects: a write through one would otherwise change the other without touching its row.
      session.launch = card.launch ? { ...card.launch } : {
        via: card.agent.host ? 'pnyx' : 'hooks',
        at: event.at,
        folder: card.agent.cwd,
        harness: card.agent.provider,
      }
    }

    if (observesPresence({
      adapter: event.data.source?.adapter,
      lastSeen: session.lastSeen,
    })) {
      session.lastSeen = event.at
    }

    if (event.type === 'card.pushed' && typeof event.data.activity === 'string') {
      session.activityObservedAt = event.data.source?.observedAt ?? event.at
    }

    session.agent = {
      ...session.agent,
      ...card.agent,
    }
    assignDefined({
      target: session,
      values: {
        terminal: card.terminal && { ...card.terminal },
        settings: card.settings && { ...card.settings },
        activity: card.activity,
        sessionActivity: card.sessionActivity,
        workingSince: card.workingSince,
        stoppedAt: card.stoppedAt,
      },
    })
    session.attention = card.attention.filter(a => a.key.startsWith('hook:')).map(a => ({ ...a }))
    const objectId = `${session.agent.sessionId}${session.agent.agentId ? `/${session.agent.agentId}` : ''}`
    session.sourceRefs = card.sourceRefs.filter(r => (r.adapter === 'hooks' && r.objectId === objectId)
      || (r.adapter === 'transcript' && r.objectId === session.agent.transcriptPath)).map(r => ({ ...r }))
  }

  if (event.type === 'card.outcome' && (event.data.after?.source === 'hooks' || event.data.before?.source === 'hooks')) {
    assignDefined({
      target: session,
      values: {
        outcome: event.data.after?.source === 'hooks' ? event.data.after : undefined,
        stoppedAt: card.stoppedAt,
      },
    })
  }

  projectSession({
    state,
    session,
  })

  if (session.taskId !== card.id && card.sessionIds?.length) {
    const attached = state.sessions[card.sessionIds[0]!]

    if (attached) {
      projectSession({
        state,
        session: attached,
      })
    }
  }
}

export const observesPresence = ({
  adapter,
  lastSeen,
}: {
  adapter?: string
  lastSeen?: string
}): boolean =>
  !lastSeen || adapter === 'hooks' || adapter === 'transcript'
