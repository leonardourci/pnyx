import type { AgentRef } from '#workers/model.ts'
import type { Card } from '#tasks/model.ts'
import type { HydraState } from '#app/model.ts'
import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import { HYDRA_CARD } from './identity.ts'
import { INTERRUPTED, sessionId } from '#workers/session-attachments.ts'
import { QUIET_REPLY, hostedHydra } from './hydra.ts'
import { REPLY_RULES, sealed, decisionsText, wakeCursor } from './wakes.ts'
import { background } from '#app/background.ts'
import { helperBatch, helperReason } from '#routine-helper/route.ts'
import { liveTask } from '#tasks/select.ts'
import { loadHydra } from '#app/store.ts'
import { pausedDeclaration } from '#tasks/lifecycle.ts'
import { reasonLine } from './wake-reasons.ts'
import { seenAt } from '#workers/presence.ts'
import { wakeHandled } from '#routine-helper/state.ts'
import type { Live } from '#app/host-types.ts'
import type { createRoutineHelper } from '#routine-helper/runner.ts'
import type { WakeReason } from './wake-reasons.ts'
import { pendingPermissions } from '#workers/permission-rules.ts'

// A stall, ended wait or unconfirmed reply the stall check found, as one reason line.
export type StallItem = WakeReason & {
  id: string
  card: string
}

// Stalled workers, ended waits and unconfirmed replies: the checks that wake Hydra when nothing else would.
export function createStallChecks({
  hydraId,
  stallDelay,
  busyDelay,
  stallRepeatMax,
  pauseDelay,
  live,
  queuedHydra,
  closing,
  helper,
  helperOpen,
  routeUpdates,
  wakeMain,
  wakeStart,
}: {
  hydraId: string
  stallDelay: number
  busyDelay: number
  stallRepeatMax: number
  pauseDelay: number
  live: Map<string, Live>
  queuedHydra: Set<string>
  closing(): boolean
  helper: ReturnType<typeof createRoutineHelper>
  helperOpen({ state }: { state: HydraState }): boolean
  routeUpdates({
    state,
    after,
  }: {
    state: HydraState
    after: number
  }): { mainOnly: Set<string> }
  wakeMain({
    id,
    text,
    tasks,
  }: {
    id: string
    text: string
    tasks: string[]
  }): unknown
  // Where Hydra's checks start before its first recorded wake.
  wakeStart(): number | undefined
}) {
  const checkStalls = async () => {
    try {
      return await wakeOnStall()
    } catch (error) {
      console.error(`pnyx-axi serve: ${(error as Error).message}`)
    }
  }

  // When a paused task's wait ends: its --until, never for a hold, or pauseDelay after a worker's pause with neither.
  const waitEnd = ({ card }: { card: Card }): number | undefined => {
    const declaration = pausedDeclaration({ card })

    if (!declaration) {
      return undefined
    }

    if (declaration.until) {
      return Date.parse(declaration.until)
    }

    // A hold keeps its worker out of stall checks too, until the owner or Hydra resumes it.
    if (declaration.hold) {
      return Infinity
    }

    // Hydra or the owner parking a task, or a task with no worker, is not a wait.
    const parked = declaration.actor === HYDRA_ACTOR || ownerActor({ actor: declaration.actor })
      || !card.sessionIds?.length

    if (parked) {
      return undefined
    }

    return Date.parse(declaration.at) + pauseDelay
  }

  // A stall fired before is due again after the stall delay doubled per earlier alarm, up to stallRepeatMax.
  const stallDue = ({
    id,
    now,
  }: {
    id: string
    now: number
  }) => {
    const fired = stalled.get(id)

    if (!fired) {
      return true
    }

    const repeatAfter = Math.min(
      stallDelay * 2 ** fired.count,
      stallRepeatMax,
    )

    return now - fired.at >= repeatAfter
  }

  const workerStalls = ({
    state,
    card,
    now,
  }: {
    state: HydraState
    card: Card & { agent: AgentRef }
    now: number
  }): StallItem[] => {
    const requests = pendingPermissions({ card })

    if (requests.length) {
      return requests.flatMap(p => {
        const waited = p.at ? now - Date.parse(p.at) : 0

        if (waited < stallDelay) {
          return []
        }

        return [
          {
            id: `stall:${p.id}`,
            card: card.id,
            kind: 'permission',
            detail: `${p.tool} has waited ${Math.round(waited / 1000)} s for an answer`,
          },
        ]
      })
    }

    const key = sessionId({ agent: card.agent })
    const entry = live.get(key)

    if (entry?.activity !== 'working') {
      return []
    }

    const declaredWaitEnd = waitEnd({ card })

    if (declaredWaitEnd !== undefined && now < declaredWaitEnd) {
      return []
    }

    const toolStarts = [...entry.tools.values()]

    if (toolStarts.length) {
      const busySince = Math.min(...toolStarts)
      const busyFor = now - busySince

      if (busyFor < busyDelay) {
        return []
      }

      return [
        {
          id: `stall:${card.id}:tool:${busySince}`,
          card: card.id,
          kind: 'quiet',
          detail: `the worker has been inside one tool call for ${Math.round(busyFor / 1000)} s`,
        },
      ]
    }

    const agent = state.sessions?.[key]
    const seen = Math.max(
      agent ? seenAt({ session: agent }) : 0,
      entry.sentAt ?? 0,
    )

    if (!seen || now - seen < stallDelay) {
      return []
    }

    return [
      {
        id: `stall:${card.id}:${seen}`,
        card: card.id,
        kind: 'quiet',
        detail: `the worker has been working with no sign of life for ${Math.round((now - seen) / 1000)} s`,
      },
    ]
  }

  // A worker that ended its turn still declaring working stopped without saying why, whoever runs it; this repeats the turn-ended wake while it lasts.
  const idleStall = ({
    state,
    card,
    now,
  }: {
    state: HydraState
    card: Card & { agent: AgentRef }
    now: number
  }): StallItem[] => {
    const turnEnded = (card.sessionActivity ?? card.activity) === 'finished'
    const declaresWorking = card.tracking === 'declared' && card.status?.state === 'working'
    const asking = card.attention.some(a => a.blocking && !a.answered)

    if (!turnEnded || !declaresWorking || asking || !liveTask({ card })) {
      return []
    }

    const session = state.sessions?.[sessionId({ agent: card.agent })]

    if (!session) {
      return []
    }

    const seen = seenAt({ session })

    if (!seen || now - seen < stallDelay) {
      return []
    }

    return [
      {
        id: `stall:${card.id}:idle:${seen}`,
        card: card.id,
        kind: 'turn ended',
        detail: `the worker ended its turn ${Math.round((now - seen) / 1000)} s ago and still declares working`,
      },
    ]
  }

  // A paused worker's wait that ended wakes Hydra once, whoever runs the worker.
  const endedWaits = ({
    state,
    now,
  }: {
    state: HydraState
    now: number
  }): StallItem[] => Object.values(state.cards).flatMap(card => {
    const declaredWaitEnd = waitEnd({ card })
    const declaration = pausedDeclaration({ card })

    const waiting = declaredWaitEnd === undefined || now < declaredWaitEnd

    if (card.id === HYDRA_CARD || !liveTask({ card }) || waiting || !declaration) {
      return []
    }

    const id = `wait:${declaration.id}`

    if (wakeHandled({
      state,
      id,
    })) {
      return []
    }

    const named = declaration.until ? `until ${declaration.until}` : `since ${declaration.at}`
    const note = declaration.note ? `: ${declaration.note}` : ''

    return [
      {
        id,
        card: card.id,
        kind: 'wait ended',
        detail: `the worker paused ${named}${note}`,
      },
    ]
  })

  // A message the worker never confirmed after its resends wakes Hydra once; the server reports it each check.
  const unconfirmedReplies = new Map<string, Omit<StallItem, 'id'>>()

  const missingReplies = ({ state }: { state: HydraState }): StallItem[] => {
    for (const id of unconfirmedReplies.keys()) {
      if (wakeHandled({
        state,
        id,
      })) {
        unconfirmedReplies.delete(id)
      }
    }

    return [...unconfirmedReplies].map(([
      id,
      item,
    ]) => ({
      id,
      ...item,
    }))
  }

  const wakeOnStall = async () => {
    const state = loadHydra({ hydraId }).state
    const hydraCard = state.cards[HYDRA_CARD]
    const session = state.config?.hydra.session

    if (closing() || !hostedHydra({ state })) {
      return
    }

    // A Hydra that cannot start holds main's stall alarms, which would otherwise be spent on starts that never reach it.
    const mainWaits = state.hydraStatus?.state === 'down' || queuedHydra.size > 0
      || (hydraCard?.sessionActivity ?? hydraCard?.activity) === 'interrupted'
      || hydraCard?.attention.some(a => a.key === INTERRUPTED)
      || (session && live.get(session)?.activity === 'working')
    const now = Date.now()
    const stalls = Object.values(state.cards).flatMap(card => {
      if (card.id === HYDRA_CARD || !card.agent) {
        return []
      }

      const worker = card as Card & { agent: AgentRef }
      const idle = idleStall({
        state,
        card: worker,
        now,
      })

      if (idle.length || card.agent.host !== 'pnyx') {
        return idle
      }

      return workerStalls({
        state,
        card: worker,
        now,
      })
    })
      .filter(stall => stallDue({
        id: stall.id,
        now,
      }))
    const waits = endedWaits({
      state,
      now,
    }).filter(wait => !stalled.has(wait.id))
    const unconfirmed = missingReplies({ state }).filter(reply => !stalled.has(reply.id))
    const fired = [
      ...stalls,
      ...waits,
      ...unconfirmed,
    ]

    if (!fired.length) {
      return
    }

    const alarm = ({ stall }: { stall: StallItem }) => {
      const count = stalled.get(stall.id)?.count ?? 0

      if (count === 0) {
        return stall.detail
      }

      return `${stall.detail} (alarm ${count + 1})`
    }

    const delivered = ({ items }: { items: StallItem[] }) => {
      const at = Date.now()

      for (const item of items) {
        const count = stalled.get(item.id)?.count ?? 0
        stalled.set(
          item.id,
          {
            count: count + 1,
            at,
          },
        )
      }
    }

    const after = wakeCursor({
      state,
      fallback: wakeStart() ?? 0,
    })
    const stallText = ({
      items,
      helper: picked = false,
    }: {
      items: StallItem[]
      helper?: boolean
    }) => `<pnyx-wake>Why you are woken:\n${items.map(item => sealed({
      text: reasonLine({
        state,
        card: item.card,
        kind: item.kind,
        detail: alarm({ stall: item }),
      }),
    })).join('\n')}\nRun \`pnyx-axi hydra check --after ${after} --hydra ${hydraId}\`; its requests and agents show what waits. If it waits on the owner, tell them in one line of reply text unless an earlier reply or its question card already did. Otherwise apply Questions and scope in your contract: answer what unambiguously fulfills the owner's accepted ask, escalate an unsettled choice, or nudge the worker. Reply only ${QUIET_REPLY} when it has already cleared or the owner was already told.\n${decisionsText({
      state,
      now,
      pick: picked ? {
        tasks: items.map(item => item.card),
        asks: [],
      } : undefined,
    })}\n${REPLY_RULES}</pnyx-wake>`
    const mainOnly = new Set([
      ...routeUpdates({
        state,
        after,
      }).mainOnly,
      ...fired.filter(item => !helperReason({
        state,
        task: item.card,
        kind: item.kind,
      })).map(item => item.card),
    ])
    const routine = fired.filter(item => !mainOnly.has(item.card))
    const batch = helperOpen({ state }) && !helper.busy() ? helperBatch({
      items: routine.map((
        item,
        index,
      ) => ({
        task: item.card,
        seq: index,
        question: false,
      })),
      prompt: ({ seqs }) => stallText({
        items: seqs.map(index => routine[index]!),
        helper: true,
      }),
    }) : undefined
    const offered = batch?.seqs.map(index => routine[index]!) ?? []

    if (batch && await helper.offer({
      tasks: batch.tasks,
      prompt: batch.text,
      seqs: [],
      once: offered.filter(item => item.kind === 'wait ended' || item.kind === 'not confirmed').map(item => item.id),
    })) {
      delivered({ items: offered })
    }

    // Alarms the helper can take stay undelivered, so they fire again for its next batch.
    const rest = fired.filter(item => !offered.includes(item)
      && (mainOnly.has(item.card) || !helperOpen({ state })))
    // A wait or reply named first keeps its own turn id, which holds it to one wake across a restart.
    const [first] = [
      ...waits,
      ...unconfirmed,
      ...stalls,
    ].filter(item => rest.includes(item))

    if (mainWaits || !first) {
      return
    }

    const firstCount = stalled.get(first.id)?.count ?? 0
    const wakeTurnId = firstCount === 0 ? first.id : `${first.id}:${firstCount + 1}`

    await wakeMain({
      id: wakeTurnId,
      text: stallText({ items: rest }),
      tasks: rest.map(item => item.card),
    })
    delivered({ items: rest })
  }

  // Each stall or wait fired so far: how many times, and when last.
  const stalled = new Map<string, {
    count: number
    at: number
  }>()
  const stallTimer = setInterval(
    () => background({
      name: 'worker stall check',
      run: checkStalls,
    }),
    Math.min(
      stallDelay / 4,
      15_000,
    ),
  )
  stallTimer.unref()

  return {
    unconfirmedReplies,
    close: () => clearInterval(stallTimer),
  }
}
