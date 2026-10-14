// Session identity and task membership, derived only from recorded events.
import { BoardError, type AgentRef, type AgentSession, type BoardEvent, type BoardState, type Card } from './model.ts'

export function sessionId({ agent }: { agent: AgentRef }): string {
  return `${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}`
}

export function liveTask({ card }: { card: Card }): boolean {
  return card.hidden !== true
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
    throw new BoardError(`session not found: ${ref}`, 'NOT_FOUND', ['Run `pnyx-axi task sessions`'])
  }

  return found
}

const firstmate = ({ card }: { card: Card }) => card.sourceRefs.some(r => r.adapter === 'firstmate')

// Refreshes the task's session fields without replacing task-owned decisions,
// outcomes, titles, links or pins. Background sessions stay in the registry.
export function projectSession({ state, session }: {
  state: BoardState
  session: AgentSession
}): void {
  const origin = state.cards[session.originCardId]

  if (origin?.automaticTask && !firstmate({ card: origin })) {
    const interactive = Boolean(session.terminal?.tty)
    origin.hidden = session.taskId !== origin.id || !interactive
  }

  const task = session.taskId && state.cards[session.taskId]

  if (!task) {
    return
  }

  task.sessionIds = [session.id]

  if (task.automaticTask) {
    task.hidden = !session.terminal?.tty
  }

  task.agent = structuredClone(session.agent)
  task.sourceRefs = [
    ...task.sourceRefs.filter(r => !session.sourceRefs.some(s =>
      r.adapter === s.adapter && r.instanceId === s.instanceId && r.objectId === s.objectId)),
    ...session.sourceRefs,
  ]
  task.settings = session.settings && { ...session.settings }
  task.terminal = session.terminal && { ...session.terminal }
  task.activity = session.activity
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
    old.attention = old.attention.filter(a => !a.key.startsWith('hook:'))

    if (old.outcome?.source === 'hooks') {
      delete old.outcome
    }

    old.revision++
    old.updatedSeq = event.seq
    old.updatedAt = event.at
  }

  session.taskId = event.data.after
  projectSession({ state, session })
}

// Legacy card pushes become task/session observations during replay. This is
// also the migration: no event bytes or old identifiers need to change.
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
    session.agent = { ...session.agent, ...card.agent }
    session.terminal = card.terminal && { ...card.terminal }
    session.settings = card.settings && { ...card.settings }
    session.activity = card.activity
    session.attention = card.attention.filter(a => a.key.startsWith('hook:'))
    const objectId = `${session.agent.sessionId}${session.agent.agentId ? `/${session.agent.agentId}` : ''}`
    session.sourceRefs = card.sourceRefs.filter(r => (r.adapter === 'hooks' && r.objectId === objectId)
      || (r.adapter === 'transcript' && r.objectId === session.agent.transcriptPath))
  }

  if (event.type === 'card.outcome' && (event.data.after?.source === 'hooks' || event.data.before?.source === 'hooks')) {
    session.outcome = event.data.after?.source === 'hooks' ? event.data.after : undefined
  }

  projectSession({ state, session })

  if (card.automaticTask && session.taskId !== card.id) {
    card.hidden = true
  }

  if (session.taskId !== card.id && card.sessionIds?.length) {
    const attached = state.sessions[card.sessionIds[0]!]

    if (attached) {
      projectSession({ state, session: attached })
    }
  }
}
