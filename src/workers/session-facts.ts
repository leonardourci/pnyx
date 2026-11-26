import { decided } from '#app/decision.ts'
import type { Decision, TitanEvent, TitanState, SourceRef } from '#app/model.ts'
import type { Card, PushFields } from '#tasks/model.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { isStaleSource, sameSource, offerTitle } from '#tasks/events.ts'
import { refreshTasks } from '#tasks/refresh.ts'
import { touch } from '#tasks/touch.ts'
import { checkRevision } from '#tasks/push-rules.ts'
import { sessionId, projectSession, sessionTask } from './session-attachments.ts'
import type { AgentSession } from './model.ts'
import { WAKE_TURN, WAKE_HANDLED } from '#titan/wake-ids.ts'
import { ownerInputUuid } from './input.ts'

export function isSessionSource({ source }: { source?: SourceRef }): boolean {
  return !source || [
    'hooks',
    'othrys',
    'transcript',
  ].includes(source.adapter)
}

export function recordTitanTurn({
  session,
  event,
}: {
  session: AgentSession
  event: TitanEvent
}): void {
  if (WAKE_TURN.test(event.id)) {
    session.wakeStarted = event.id
  }

  session.hydraTurn = {
    id: event.id,
    seq: event.seq,
    resumes: event.id.startsWith('resume:') ? (session.hydraTurn?.resumes ?? 0) + 1 : 0,
    finishedThrough: session.turnFinishedSeq ?? 0,
  }
}

function recordTurn({
  session,
  event,
  activity,
}: {
  session: AgentSession
  event: TitanEvent
  activity: string
}): void {
  if (session.agent.host !== 'othrys' || session.agent.agentId) {
    return
  }

  const wasWorking = session.sessionActivity === 'working'
  const newResume = event.id.startsWith('resume:') && session.turn?.id !== event.id

  if (activity === 'working' && (!wasWorking || !session.turn || newResume)) {
    session.turn = {
      id: event.id,
      seq: event.seq,
      resumes: event.id.startsWith('resume:') ? (session.turn?.resumes ?? 0) + 1 : 0,
      finishedThrough: session.turnFinishedSeq ?? 0,
    }
  }

  if (activity === 'finished' && (wasWorking || session.turnFinishedSeq === undefined)) {
    session.turnFinishedSeq = event.seq
  }

  if (activity === 'finished' && WAKE_HANDLED.test(event.id)) {
    session.wakeHandled = event.id
  }
}

function sessionActivity({
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
  state: TitanState
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

export function sessionTaskFields({ fields }: { fields: PushFields }): PushFields {
  return Object.fromEntries(Object.entries(fields).filter(([field]) => [
    'title',
    'autoTitle',
    'project',
    'workspace',
    'tags',
    'folder',
    'parentId',
    'rank',
  ].includes(field)))
}

export function applySessionFacts({
  state,
  event,
}: {
  state: TitanState
  event: Extract<import('#app/model.ts').TitanEvent, { type: 'session.observed' }>
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
      via = 'othrys'
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
  const fileOrdered = source?.adapter === 'transcript' && source.instanceId !== undefined
    && source.generation !== undefined
  const staleActivity = !fileOrdered && previousActivityAt !== undefined
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
    const ended = [
      'finished',
      'interrupted',
      'ended',
    ].includes(fields.activity)
    const changed = fields.activity !== session.sessionActivity

    if (ended && changed && state.hydraSessions?.includes(session.id)) {
      state.nativeTimes = [
        ...state.nativeTimes ?? [],
        {
          seq: event.seq,
          at: event.at,
        },
      ]
    }

    recordTurn({
      session,
      event,
      activity: fields.activity,
    })
    sessionActivity({
      target: session,
      activity: fields.activity,
      at: event.at,
      seq: event.seq,
    })
    session.activityObservedAt = activityAt
  }

  if (fileOrdered && state.config?.hydra.session === session.id) {
    const input = source.cursor && state.hydraMessages?.find(message =>
      ownerInputUuid({ id: message.id }) === source.cursor)
    const inputSeq = input && state.eventIds[input.id]

    if (fields.activity === 'working' && input && typeof inputSeq === 'number') {
      recordTitanTurn({
        session,
        event: {
          ...event,
          id: `${input.id}:hosted`,
          seq: inputSeq,
        },
      })
    } else if (fields.activity === 'working' && event.id.startsWith('resume:')) {
      recordTitanTurn({
        session,
        event,
      })
    }

    if (fields.activity === 'finished' && session.hydraTurn) {
      session.turnFinishedSeq = session.hydraTurn.seq
    }
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
      } = sessionTaskFields({ fields })

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
  event: import('#app/model.ts').TitanEvent
  state?: TitanState
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

  return event.type === 'task.edited' ? event.data : undefined
}
