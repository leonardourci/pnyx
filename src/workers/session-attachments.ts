import { cloneValue } from '#app/preimage.ts'
import type { AgentRef, AgentSession, TerminalFacts, SessionEvent } from './model.ts'
import type { Card } from '#tasks/model.ts'
import type { HydraState, HydraEvent } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'

// The open request marking a hosted agent's turn cut off by a server stop; it belongs
// to that agent, so it goes when the agent leaves the task.
export const INTERRUPTED = 'pnyx:interrupted'

export function sessionId({ agent }: { agent: AgentRef }): string {
  return `${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}`
}

export function interactive({ session }: { session: AgentSession }): boolean {
  return Boolean(session.terminal?.tty || session.agent.paseoAgentId || session.agent.host)
}

export function cardSessionId({ card }: { card: Card }): string | undefined {
  return card.sessionIds?.[0] ?? (card.agent ? sessionId({ agent: card.agent }) : undefined)
}

export function findSession({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): AgentSession {
  const direct = state.sessions?.[ref]
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']
  const found = direct ?? Object.values(state.sessions ?? {}).find(s =>
    card?.sessionIds?.includes(s.id) || s.sourceRefs.some(r => `${r.instanceId}:${r.objectId}` === ref))

  if (!found) {
    throw new HydraError({
      message: `session not found: ${ref}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi task sessions`'],
    })
  }

  return found
}

// The session running in the caller's own terminal, for `--session self`: the newest
// live session whose Paseo terminal, tmux pane or Herdr pane matches.
export function selfSession({
  state,
  here,
}: {
  state: HydraState
  here: Pick<TerminalFacts, 'paseoTerminal' | 'tmuxPane' | 'herdrPane'>
}): AgentSession {
  const keys = ([
    'paseoTerminal',
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
      message: keys.length ? 'no recorded session runs in this terminal' : 'cannot tell this terminal: no Paseo, tmux or Herdr pane in the environment',
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi task sessions` and pass --session <id>'],
    })
  }

  return found
}

const firstmate = ({ card }: { card: Card }) => card.sourceRefs.some(r => r.adapter === 'firstmate')

// An absent value deletes its key, so the state keeps its shape through a snapshot's JSON.
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

// Membership projection preserves task-owned fields when the session changes.
export function projectSession({
  state,
  session,
}: {
  state: HydraState
  session: AgentSession
}): void {
  const task = session.taskId && state.cards[session.taskId]

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
      stoppedAt: session.stoppedAt,
    },
  })
  task.attention = [
    ...task.attention.filter(a => !a.key.startsWith('hook:')),
    ...session.attention,
  ]

  if (!task.outcome || task.outcome.source === 'hooks') {
    if (session.outcome && !firstmate({ card: task })) {
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
}): void {
  const session = state.sessions?.[event.data.session]

  if (!session || session.taskId !== event.data.before) {
    return
  }

  const old = session.taskId && state.cards[session.taskId]

  if (old) {
    old.sessionIds = []
    delete old.agent
    delete old.settings
    delete old.terminal
    delete old.activity
    delete old.sessionActivity
    delete old.workingSince
    delete old.stoppedAt
    old.attention = old.attention.filter(a => !a.key.startsWith('hook:') && a.key !== INTERRUPTED)

    if (old.outcome?.source === 'hooks') {
      delete old.outcome
    }

    old.revision++
    old.updatedSeq = event.seq
    old.updatedAt = event.at
  }

  const target = event.data.after && state.cards[event.data.after]

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
    taskId: card.sessionIds?.length && !card.sessionIds.includes(id) ? null : card.id,
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

    session.launch ??= card.launch ?? {
      via: card.agent.paseoAgentId ? 'paseo' : card.agent.host ? 'pnyx' : 'hooks',
      at: event.at,
      folder: card.agent.cwd,
      harness: card.agent.provider,
    }

    if (!session.lastSeen || event.data.source?.adapter === 'hooks' || event.data.source?.adapter === 'paseo' || event.data.source?.adapter === 'transcript') {
      session.lastSeen = event.at
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
    session.attention = card.attention.filter(a => a.key.startsWith('hook:'))
    const objectId = `${session.agent.sessionId}${session.agent.agentId ? `/${session.agent.agentId}` : ''}`
    session.sourceRefs = card.sourceRefs.filter(r => (r.adapter === 'hooks' && r.objectId === objectId)
      || (r.adapter === 'transcript' && r.objectId === session.agent.transcriptPath)
      || (r.adapter === 'paseo' && r.objectId === session.agent.paseoAgentId))
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

export function taskForMessage({
  memberships,
  at,
  fallback,
}: {
  memberships: SessionEvent[]
  at?: string
  fallback: string
}): string {
  let task = memberships.find(e => e.data.after)?.data.after ?? fallback
  const stamp = Date.parse(at ?? '')

  if (!Number.isFinite(stamp)) {
    return fallback
  }

  for (const event of memberships) {
    if (Date.parse(event.at) <= stamp && event.data.after) {
      task = event.data.after
    }
  }

  return task
}
