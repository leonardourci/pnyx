import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { NativeWork } from '#workers/provider.ts'
import { nativeIdle } from '#workers/native-work.ts'
import { activeHelperBatches } from '#routine-helper/state.ts'
import { spoolFiles } from '#store/storage.ts'
import { recoveryCandidates } from './recovery-state.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'

export interface NativeHealth {
  sessionId: string
  taskId?: string
  attached: boolean
  stale?: boolean
  generation?: number
  leased?: boolean
  work?: NativeWork
  inputs: {
    id: string
    taskId: string
    taken: boolean
  }[]
}

export interface RuntimeHealth {
  sessions: NativeHealth[]
  helper: {
    busy: boolean
    enabled?: boolean
    batchId?: string
    sessionId?: string
    work?: NativeWork
    deadlineAt?: number
  }
  scheduler: {
    lastSuccessAt?: string
    lastSuccessSeq?: number
    lastFailureAt?: string
  }
}

function boundedWork({
  work,
  limit,
}: {
  work?: NativeWork
  limit: number
}) {
  if (!work) {
    return undefined
  }

  return {
    runningTurns: work.runningTurns.slice(
      0,
      limit,
    ),
    runningTools: work.runningTools.slice(
      0,
      limit,
    ),
    unsettledInputs: work.unsettledInputs.slice(
      0,
      limit,
    ),
    pendingControls: work.pendingControls.slice(
      0,
      limit,
    ),
    queue: work.queue,
    background: work.background.knowledge === 'known'
      ? {
        knowledge: 'known',
        tasks: work.background.tasks.slice(
          0,
          limit,
        ),
        total: work.background.tasks.length,
      }
      : { knowledge: 'unknown' },
    totals: {
      runningTurns: work.runningTurns.length,
      runningTools: work.runningTools.length,
      unsettledInputs: work.unsettledInputs.length,
      pendingControls: work.pendingControls.length,
    },
  }
}

export function nativeHealth({
  sessions,
  limit,
}: {
  sessions: NativeHealth[]
  limit: number
}) {
  const inputs = sessions.flatMap(session => {
    const known = new Set(session.inputs.map(input => input.id))

    return [
      ...session.inputs.map(input => ({
        sessionId: session.sessionId,
        taskId: input.taskId,
        id: input.id,
        phase: input.taken ? 'awaiting_settlement' : 'awaiting_admission',
      })),
      ...(session.work?.unsettledInputs ?? []).filter(id => !known.has(id)).map(id => ({
        sessionId: session.sessionId,
        taskId: session.taskId,
        id,
        phase: 'unsettled',
      })),
    ]
  })
  const retained = sessions.filter(session => session.stale && session.work
    && !nativeIdle({ work: session.work }))

  return {
    sessions: sessions.slice(
      0,
      limit,
    ).map(session => ({
      ...session,
      inputs: session.inputs.slice(
        0,
        limit,
      ),
      inputsTotal: session.inputs.length,
      work: boundedWork({
        work: session.work,
        limit,
      }),
    })),
    sessionsTotal: sessions.length,
    inputs: inputs.slice(
      0,
      limit,
    ),
    inputsTotal: inputs.length,
    retainedOwnership: retained.slice(
      0,
      limit,
    ).map(session => ({
      sessionId: session.sessionId,
      taskId: session.taskId,
      reason: 'settings retirement waits for native work to settle',
    })),
    retainedTotal: retained.length,
  }
}

export function healthFacts({
  state,
  dir,
  now,
  limit,
  runtime,
  events = [],
  blocked = [],
}: {
  state: HydraState
  events?: HydraEvent[]
  blocked?: {
    taskId: string
    messageId: string
    reason: string
  }[]
  dir: string
  now: number
  limit: number
  runtime?: RuntimeHealth
}) {
  const batches = activeHelperBatches({ state }).map(batch => {
    const active = runtime?.helper.batchId === batch.id ? runtime.helper : undefined
    const deadline = active?.deadlineAt

    return {
      batchId: batch.id,
      startedAt: batch.startedAt,
      ageMs: batch.startedAt ? Math.max(
        0,
        now - Date.parse(batch.startedAt),
      ) : undefined,
      deadline: deadline === undefined ? undefined : new Date(deadline).toISOString(),
      overdue: deadline === undefined ? 'unknown' : now >= deadline,
      ownership: active?.sessionId ? 'attached' : 'unknown',
      sessionId: active?.sessionId,
      work: boundedWork({
        work: active?.work,
        limit,
      }),
    }
  })
  const pending = join(
    dir,
    'helper-pending',
  )
  const completions = existsSync(pending) ? readdirSync(pending).filter(name => !name.startsWith('.') && name.endsWith('.json')) : []
  const spool = spoolFiles({ dir })
  const oldest = spool[0]
  const oldestStat = oldest ? statSync(
    oldest,
    { throwIfNoEntry: false },
  ) : undefined
  const native = runtime ? nativeHealth({
    sessions: runtime.sessions,
    limit,
  }) : { runtime: 'unknown' }

  const recoveries = recoveryCandidates({
    state,
    sessions: runtime?.sessions ?? [],
    enabled: runtime?.helper.enabled === true,
    now,
    events,
  })

  return {
    observedAt: new Date(now).toISOString(),
    seq: state.seq,
    runtime: runtime ? 'available' : 'unknown',
    scheduler: runtime ? runtime.scheduler : { lastSuccessAt: 'unknown' },
    helper: {
      busy: runtime?.helper.busy ?? 'unknown',
      batches: batches.slice(
        0,
        limit,
      ),
      total: batches.length,
    },
    native,
    recovery: {
      blocked: blocked.slice(
        0,
        limit,
      ),
      blockedTotal: blocked.length,
      total: recoveries.length,
      messages: recoveries.slice(
        0,
        limit,
      ).map(candidate => {
        const stopped = blocked.find(incident => incident.taskId === candidate.taskId
          && incident.messageId === candidate.messageId)

        return stopped ? {
          ...candidate,
          eligible: false,
          reason: stopped.reason,
        } : candidate
      }),
    },
    pendingCompletions: {
      total: completions.length,
      batches: completions.slice(
        0,
        limit,
      ).map(name => name.slice(
        0,
        -'.json'.length,
      )),
    },
    spool: {
      eligible: spool.length,
      oldest: oldest && oldestStat ? {
        id: basename(oldest),
        writtenAt: oldestStat.mtime.toISOString(),
      } : 'none',
    },
  }
}
