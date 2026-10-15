import { BoardError, type AgentRef, type AgentSession, type BoardEvent, type BoardState, type Card, type TerminalFacts, type SessionEvent } from './model.ts'

export function sessionId({ agent }: { agent: AgentRef }): string {
  return `${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}`
}

export function interactive({ session }: { session: AgentSession }): boolean {
  return Boolean(session.terminal?.tty || session.agent.paseoAgentId || session.agent.host)
}

export function liveTask({ card }: { card: Card }): boolean {
  return card.hidden !== true && !card.automaticTask
}

export function rankOf({ card }: { card: Card }): number {
  return card.rank ?? card.createdSeq
}

export function columnCards({ state, column }: { state: BoardState; column: string }): Card[] {
  return Object.values(state.cards)
    .filter(c => liveTask({ card: c }) && c.column === column)
    .sort((a, b) => rankOf({ card: a }) - rankOf({ card: b }) || a.id.localeCompare(b.id))
}

export function cardSessionId({ card }: { card: Card }): string | undefined {
  return card.sessionIds?.[0] ?? (card.agent ? sessionId({ agent: card.agent }) : undefined)
}

export function findSession({ state, ref }: { state: BoardState; ref: string }): AgentSession {
  const direct = state.sessions?.[ref]
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']
  const found = direct ?? Object.values(state.sessions ?? {}).find(s =>
    card?.sessionIds?.includes(s.id) || s.sourceRefs.some(r => `${r.instanceId}:${r.objectId}` === ref))

  if (!found) {
    throw new BoardError({ message: `session not found: ${ref}`, code: 'NOT_FOUND', help: ['Run `pnyx-axi task sessions`'] })
  }

  return found
}

// The session running in the caller's own terminal, for `--session self`: the newest
// live session whose Paseo terminal, tmux pane or Herdr pane matches.
export function selfSession({ state, here }: {
  state: BoardState
  here: Pick<TerminalFacts, 'paseoTerminal' | 'tmuxPane' | 'herdrPane'>
}): AgentSession {
  const keys = (['paseoTerminal', 'tmuxPane', 'herdrPane'] as const).filter(k => here[k])
  const rank = ({ s }: { s: AgentSession }) => (s.activity === 'ended' ? 0 : 1e12)
    + (state.cards[s.taskId ?? s.originCardId]?.updatedSeq ?? 0)
  const found = Object.values(state.sessions ?? {})
    .filter(s => keys.some(k => s.terminal?.[k] === here[k]))
    .sort((a, b) => rank({ s: b }) - rank({ s: a }))[0]

  if (!found) {
    throw new BoardError({ message: keys.length ? 'no recorded session runs in this terminal' : 'cannot tell this terminal: no Paseo, tmux or Herdr pane in the environment', code: 'NOT_FOUND', help: ['Run `pnyx-axi task sessions` and pass --session <id>'] })
  }

  return found
}

const firstmate = ({ card }: { card: Card }) => card.sourceRefs.some(r => r.adapter === 'firstmate')

// An absent value deletes its key, so the state keeps its shape through a snapshot's JSON.
export function assignDefined<T extends object>({ target, values }: {
  target: T
  values: Partial<T>
}): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete (target as Record<string, unknown>)[key]
    } else {
      (target as Record<string, unknown>)[key] = value
    }
  }
}

// Membership projection preserves task-owned fields when the session changes.
export function projectSession({ state, session }: {
  state: BoardState
  session: AgentSession
}): void {
  const task = session.taskId && state.cards[session.taskId]

  if (!task) {
    return
  }

  task.sessionIds = [session.id]
  task.agent = structuredClone(session.agent)
  task.launch = session.launch && structuredClone(session.launch)
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
    },
  })
  task.attention = [...task.attention.filter(a => !a.key.startsWith('hook:')), ...session.attention]

  if (!task.outcome || task.outcome.source === 'hooks') {
    if (session.outcome && !firstmate({ card: task })) {
      task.outcome = { ...session.outcome }
    } else {
      delete task.outcome
    }
  }
}

export function applyAttachment({ state, event }: {
  state: BoardState
  event: Extract<BoardEvent, { type: 'task.session'}>
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
    old.attention = old.attention.filter(a => !a.key.startsWith('hook:'))

    if (old.outcome?.source === 'hooks') {
      delete old.outcome
    }

    old.revision++
    old.updatedSeq = event.seq
    old.updatedAt = event.at
  }

  const target = event.data.after && state.cards[event.data.after]

  if (target && target.launch?.via === 'command' && session.launch?.via === 'hooks') {
    session.launch = { ...target.launch, harness: session.agent.provider }
  }

  session.taskId = event.data.after
  projectSession({ state, session })
}

// Replay migrates legacy observations without changing event bytes or ids.
export function observeSession({ state, card, event }: {
  state: BoardState
  card: Card
  event: BoardEvent
}): void {
  if (!card.agent || event.type === 'task.session') {
    return
  }

  const id = sessionId({ agent: card.agent })
  state.sessions ??= {}
  const session = state.sessions[id] ??= {
    id,
    agent: structuredClone(card.agent),
    originCardId: card.id,
    taskId: card.sessionIds?.length && !card.sessionIds.includes(id) ? null : card.id,
    attention: [],
    sourceRefs: [],
  }

  if (event.type === 'card.pushed') {
    session.launch ??= card.launch ?? { via: card.agent.paseoAgentId ? 'paseo' : 'hooks', at: event.at, folder: card.agent.cwd, harness: card.agent.provider }

    if (!session.lastSeen || event.data.source?.adapter === 'hooks' || event.data.source?.adapter === 'paseo' || event.data.source?.adapter === 'transcript') {
      session.lastSeen = event.at
    }

    session.agent = { ...session.agent, ...card.agent }
    assignDefined({
      target: session,
      values: {
        terminal: card.terminal && { ...card.terminal },
        settings: card.settings && { ...card.settings },
        activity: card.activity,
        sessionActivity: card.sessionActivity,
      },
    })
    session.attention = card.attention.filter(a => a.key.startsWith('hook:'))
    const objectId = `${session.agent.sessionId}${session.agent.agentId ? `/${session.agent.agentId}` : ''}`
    session.sourceRefs = card.sourceRefs.filter(r => (r.adapter === 'hooks' && r.objectId === objectId)
      || (r.adapter === 'transcript' && r.objectId === session.agent.transcriptPath)
      || (r.adapter === 'paseo' && r.objectId === session.agent.paseoAgentId))
  }

  if (event.type === 'card.outcome' && (event.data.after?.source === 'hooks' || event.data.before?.source === 'hooks')) {
    assignDefined({ target: session, values: { outcome: event.data.after?.source === 'hooks' ? event.data.after : undefined } })
  }

  projectSession({ state, session })

  if (session.taskId !== card.id && card.sessionIds?.length) {
    const attached = state.sessions[card.sessionIds[0]!]

    if (attached) {
      projectSession({ state, session: attached })
    }
  }
}

export function taskForMessage({ memberships, at, fallback }: {
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
