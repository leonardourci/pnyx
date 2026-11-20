import { decided } from '#app/decision.ts'
import type { Decision, HydraState, SourceRef } from '#app/model.ts'
import type { Card, PushFields } from '#tasks/model.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { isStaleSource, sameSource, offerTitle } from '#tasks/events.ts'
import { refreshTasks } from '#tasks/columns.ts'
import { touch } from '#tasks/touch.ts'
import { checkRevision } from '#tasks/push-rules.ts'
import { sessionId, projectSession, sessionTask } from './session-attachments.ts'
import type { AgentSession } from './model.ts'

export function isSessionSource({ source }: { source?: SourceRef }): boolean {
  return !source || [
    'hooks',
    'pnyx',
    'transcript',
  ].includes(source.adapter)
}

export function sessionActivity({
  target,
  activity,
  at,
  seq,
}: {
  target: Pick<Card, 'activity' | 'sessionActivity' | 'workingSince' | 'turnStartedAt' | 'turnEndedSeq' | 'stoppedAt'>
  activity: string
  at: string
  seq: number
}): void {
  target.activity = activity

  if (activity === 'working') {
    if (target.sessionActivity !== 'working' || !target.workingSince) {
      target.workingSince = at
      target.turnStartedAt = at
    }
  } else {
    if (target.sessionActivity === 'working') {
      target.turnEndedSeq = seq
    }

    delete target.workingSince
  }

  if (activity === 'ended') {
    target.stoppedAt = at
  } else {
    delete target.stoppedAt
  }

  target.sessionActivity = activity
}

export function decideSessionFacts({
  state,
  fields,
  source,
  meta,
  task,
  session,
  cursor,
  key,
}: {
  state: HydraState
  fields: PushFields & { agent: AgentSession['agent'] }
  source?: SourceRef
  meta: Meta
  task?: Card
  session?: AgentSession
  cursor?: AgentSession['activityCursor']
  key?: string
}): Decision {
  const agent = fields.agent
  const owner = task ?? sessionTask({
    state,
    agent,
  })

  if (owner) {
    checkRevision({
      card: owner,
      ifRevision: meta.ifRevision,
    })
  }

  if (source && isStaleSource({
    card: session,
    source,
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
        cardId: owner?.id ?? '$sessions',
      }),
      type: 'session.observed',
      data: {
        key,
        cursor,
        fields: {
          ...fields,
          agent,
        },
        source,
        task: owner?.id,
        before: { attention: owner?.attention ?? session?.attention ?? [] },
      },
    },
  })
}

export function applySessionFacts({
  state,
  event,
}: {
  state: HydraState
  event: Extract<import('#app/model.ts').HydraEvent, { type: 'session.observed' }>
}): void {
  if ('session' in event.data) {
    const session = state.sessions?.[event.data.session]

    if (!session) {
      return
    }

    applySessionFacts({
      state,
      event: {
        ...event,
        data: {
          fields: {
            agent: session.agent,
            activity: event.data.activity,
            attention: event.data.attention,
          },
        },
      },
    })

    return
  }

  const {
    fields,
    source,
  } = event.data
  const id = sessionId({ agent: fields.agent })

  if (!state.sessions) {
    state.sessions = {}
  }

  let session = state.sessions[id]

  if (source && isStaleSource({
    card: session,
    source,
  })) {
    return
  }

  if (!session) {
    let via: NonNullable<AgentSession['launch']>['via'] = 'hooks'

    if (fields.agent.host) {
      via = 'pnyx'
    }

    const task = state.cards[event.data.task ?? '']
    const canAttach = task && !fields.agent.agentId && !task.agent && !task.sessionIds?.length

    session = {
      id,
      createdBy: event.id,
      agent: { ...fields.agent },
      originCardId: event.data.task ?? '',
      taskId: canAttach ? task.id : null,
      attention: [],
      sourceRefs: [],
      launch: {
        via,
        at: event.at,
        folder: fields.agent.cwd,
        harness: fields.agent.provider,
      },
    }
    state.sessions[id] = session
  }

  if (event.data.cursor) {
    session.activityCursor = { ...event.data.cursor }

    return
  }

  session.agent = {
    ...session.agent,
    ...fields.agent,
  }

  const activityAt = source?.observedAt ?? event.at
  const previousActivityAt = session.activityObservedAt
  const staleActivity = previousActivityAt !== undefined
    && Date.parse(activityAt) < Date.parse(previousActivityAt)

  if (source) {
    session.sourceRefs = [
      ...session.sourceRefs.filter(known => !sameSource({
        a: known,
        b: source,
      })),
      { ...source },
    ]

    if (!session.lastSeen || Date.parse(event.at) >= Date.parse(session.lastSeen)) {
      session.lastSeen = event.at
    }
  }

  if (fields.title !== undefined) {
    session.title = fields.title ?? session.autoTitle?.text
    session.titleSet = fields.title !== null
  }

  if (fields.autoTitle) {
    offerTitle({
      card: session,
      next: fields.autoTitle,
    })
  }

  if (fields.settings !== undefined) {
    session.settings = fields.settings ?? undefined
  }

  if (fields.terminal !== undefined) {
    session.terminal = { ...fields.terminal }
  }

  if (fields.attention !== undefined && !staleActivity) {
    session.attention = fields.attention.map(item => ({ ...item }))
  }

  if (typeof fields.activity === 'string' && !staleActivity) {
    sessionActivity({
      target: session,
      activity: fields.activity,
      at: event.at,
      seq: event.seq,
    })
    session.activityObservedAt = activityAt
  }

  projectSession({
    state,
    session,
  })
  const assigned = sessionTask({
    state,
    agent: session.agent,
  })
  const task = state.cards[event.data.task ?? ''] ?? assigned

  if (assigned && assigned.id !== task?.id) {
    touch({
      card: assigned,
      event,
    })
  }

  if (task) {
    if (event.data.task === task.id) {
      const {
        title,
        project,
        workspace,
        tags,
        folder,
        parentId,
        rank,
      } = fields

      if (title !== undefined) {
        task.title = title ?? task.autoTitle?.text ?? task.key
        task.titleSet = title !== null
      }

      if (fields.autoTitle) {
        offerTitle({
          card: task,
          next: fields.autoTitle,
        })
      }

      if (workspace !== undefined) {
        task.workspace = workspace
      }

      if (tags !== undefined) {
        task.tags = [...tags]
      }

      for (const [
        field,
        value,
      ] of Object.entries({
          project,
          folder,
          parentId,
          rank,
        })) {
        if (value === null) {
          delete task[field as 'project' | 'folder' | 'parentId' | 'rank']
        } else if (value !== undefined) {
          Object.assign(
            task,
            { [field]: value },
          )
        }
      }
    }

    touch({
      card: task,
      event,
    })
  }

  refreshTasks({ state })
}

export function sessionFields({
  event,
  state,
}: {
  event: import('#app/model.ts').HydraEvent
  state?: HydraState
}): PushFields | undefined {
  if (event.type === 'session.observed') {
    if ('fields' in event.data) {
      return event.data.fields
    }

    return {
      activity: event.data.activity,
      attention: event.data.attention,
      agent: state?.sessions?.[event.data.session]?.agent,
    }
  }

  return event.type === 'card.pushed' ? event.data : undefined
}
