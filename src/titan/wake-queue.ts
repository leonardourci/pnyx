import { background } from '#app/background.ts'
import { readChanges } from '#app/event-log.ts'
import type { Host, Live } from '#app/host-types.ts'
import type { TitanState } from '#app/model.ts'
import { loadTitan } from '#app/store.ts'
import { helperBatch, helperEvent } from '#routine-helper/route.ts'
import type { createRoutineHelper } from '#routine-helper/runner.ts'
import { activeHelperBatches, failedBatches, ownerOutcomes } from '#routine-helper/state.ts'
import { INTERRUPTED } from '#workers/session-attachments.ts'
import { othrysRunsTitan, reportActor } from './titan.ts'
import { TITAN_CARD } from './identity.ts'
import { eventReasons } from './wake-reasons.ts'
import { wakeCursor, wakeText, type QueuedUpdate } from './wakes.ts'
import { wakeId, WAKE_ID } from './wake-ids.ts'

// Titan's unread changes and when it is woken for them: its check turns, the read cursor, and the updates the routine helper takes instead.
export function createWakeQueue({
  titanId,
  wakeDelay,
  live,
  queuedTitan,
  closing,
  queued,
  helper,
  helperPending,
  helperOpen,
  host,
}: {
  titanId: string
  wakeDelay: number
  live: Map<string, Live>
  queuedTitan: Set<string>
  closing(): boolean
  queued(): void
  helper: ReturnType<typeof createRoutineHelper>
  helperPending(): boolean
  helperOpen({ state }: { state: TitanState }): boolean
  host(): Host
}) {
  // Recorded wakes, or wakeStart before the first, say how far Titan has checked.
  let wakeThrough = 0, wakeStart: number | undefined
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  // Changes since Titan's last finished check turn; the ones through readThrough are in its running turn.
  let updates: QueuedUpdate[] = []
  // Each queued change's reason lines, worked out from the state it landed in.
  const wakeReasonsAt = new Map<number, string[]>()
  // ponytail: helper work main's wake passed over stays queued here in memory; a restart leaves it to the task's state and the timed review.
  const parked = new Set<number>()
  // Parked updates each main wake delivers, by its through seq; they leave the queue once that turn finishes.
  const wakeParked = new Map<number, number[]>()
  let readingParked: number[] = []
  let readThrough = 0

  // Tasks main's running turn was woken for; the helper leaves them until that turn ends.
  const mainTasks = new Set<string>()
  // A wake's tasks join mainTasks only once its turn really starts.
  const wakeTasks = new Map<string, string[]>()

  const wakeMain = ({
    id,
    text,
    tasks,
  }: {
    id: string
    text: string
    tasks: string[]
  }) => {
    wakeTasks.set(
      id,
      tasks,
    )

    return host().titan({
      id,
      actor: 'othrys',
      text,
    })
      .finally(() => wakeTasks.delete(id))
  }

  // One check turn at a time; a busy Titan is woken when its turn finishes.
  const armWake = () => {
    if (!closing() && !wakeTimer && (wakeThrough || helperPending())) {
      wakeTimer = setTimeout(
        () => background({
          name: 'Titan wake',
          run: fireWake,
          retry: armWake,
        }),
        wakeDelay,
      )
    }
  }

  const updatesText = ({
    state,
    seqs,
  }: {
    state: TitanState
    seqs: number[]
  }) => {
    const chosen = new Set(seqs)
    const reports = (state.titanMessages ?? [])
      .filter(message => chosen.has(state.eventIds[message.id] ?? -1)
      && reportActor({ actor: message.actor }))

    return wakeText({
      titanId,
      state,
      now: Date.now(),
      reasons: [...new Set(seqs.flatMap(seq => wakeReasonsAt.get(seq) ?? []))],
      reports,
      check: reports.length < chosen.size,
      reportSeqs: seqs,
      pick: {
        tasks: updates.filter(update => chosen.has(update.seq)).map(update => update.card),
        asks: reports.flatMap(message => message.ask ?? []),
      },
    })
  }

  // Unread updates the helper may take; main keeps the tasks it handles now or has other updates for.
  const routeUpdates = ({
    state,
    after,
  }: {
    state: TitanState
    after: number
  }) => {
    const unread = updates.filter(update => !state.helper?.handled.includes(update.seq)
      && ((update.seq > after && update.seq <= wakeThrough) || parked.has(update.seq)))
    const seqs = new Set(unread.map(update => update.seq))
    const routed = new Map(seqs.size ? readChanges({
      titanId,
      seqs: [...seqs],
    })
      .flatMap(event => {
        const task = helperEvent({
          state,
          event,
        })

        return task ? [
          [
            event.seq,
            {
              task,
              question: event.type === 'titan.message' && !!event.data.ask,
            },
          ],
        ] as const : []
      }) : [])
    // Main keeps a task whose outcome or hand-back it has not acknowledged, so it can act on what the helper escalated.
    const mainOnly = new Set([
      ...mainTasks,
      ...unread.filter(update => !routed.has(update.seq)).map(update => update.card),
      ...ownerOutcomes({ state }).map(outcome => outcome.task),
      ...failedBatches({ state }).flatMap(batch => batch.tasks),
    ])
    const items = [...routed]
      .filter(([
        , item,
      ]) => !mainOnly.has(item.task))
      .map(([
        seq,
        item,
      ]) => ({
        seq,
        ...item,
      }))

    return {
      items,
      mainOnly,
    }
  }

  // Runs before main's wake checks so the helper takes routine tasks even while main works.
  const offerUpdates = async ({
    state,
    after,
  }: {
    state: TitanState
    after: number
  }) => {
    if (!helperOpen({ state }) || helper.busy()) {
      return
    }

    const batch = helperBatch({
      items: routeUpdates({
        state,
        after,
      }).items,
      prompt: ({ seqs }) => updatesText({
        state,
        seqs,
      }),
    })

    if (!batch) {
      return
    }

    const claimed = new Set(batch.seqs)

    if (await helper.offer({
      tasks: batch.tasks,
      prompt: batch.text,
      seqs: batch.seqs,
    })) {
      updates = updates.filter(update => !claimed.has(update.seq))

      for (const seq of claimed) {
        parked.delete(seq)
      }

      wakeThrough = Math.max(
        0,
        ...updates.map(update => update.seq),
      )
      queued()
    }
  }

  const fireWake = async () => {
    wakeTimer = undefined
    const current = loadTitan({ titanId }).state

    if (closing() || !othrysRunsTitan({ state: current })) {
      return
    }

    await offerUpdates({
      state: current,
      after: wakeCursor({
        state: current,
        fallback: wakeStart ?? 0,
      }),
    })
    const state = loadTitan({ titanId }).state
    const session = state.config?.titan.session
    const card = state.cards[TITAN_CARD]
    const after = wakeCursor({
      state,
      fallback: wakeStart ?? 0,
    })

    // An interrupted Titan waits for the owner; the next change after that wakes it.
    if ((card?.sessionActivity ?? card?.activity) === 'interrupted'
      || card?.attention.some(a => a.key === INTERRUPTED)
      || queuedTitan.size || (session && live.get(session)?.activity === 'working')) {
      return
    }

    const open = helperOpen({ state })
    // Updates the helper can take wait for its next batch rather than riding along with main's.
    const helperSeqs = new Set(open ? routeUpdates({
      state,
      after,
    }).items.map(item => item.seq) : [])
    // A parked update the helper can no longer take is main's, even below main's cursor.
    const batch = updates.filter(update => !helperSeqs.has(update.seq)
      && (parked.has(update.seq) || (update.seq > after && update.seq <= wakeThrough)))

    if (!batch.length) {
      if (helperPending()) {
        return host().titan({
          id: `helper-outcomes:${state.seq}`,
          actor: 'othrys',
          text: '<othrys-wake>The routine helper left outcomes or handed a batch back. Handle the pending records below; relay owner outcomes in one plain line each with full links.</othrys-wake>',
        })
      }

      return
    }

    const through = Math.max(
      after,
      ...batch.map(update => update.seq),
    )
    wakeParked.set(
      through,
      batch.filter(update => parked.has(update.seq)).map(update => update.seq),
    )

    for (const seq of helperSeqs) {
      if (seq <= through) {
        parked.add(seq)
      }
    }

    // Progress is never queued, so main's reports are every unread message the helper does not hold.
    const held = new Set(activeHelperBatches({ state }).flatMap(batch => batch.seqs))
    const reports = (state.titanMessages ?? []).filter(message => {
      const seq = state.eventIds[message.id]

      if (seq === undefined || !reportActor({ actor: message.actor })) {
        return false
      }

      const unread = seq > after && seq <= through && !state.helper?.handled.includes(seq)

      return batch.some(update => update.seq === seq)
        || (unread && !held.has(seq) && !helperSeqs.has(seq) && !parked.has(seq))
    })
    const reportSeqs = new Set(reports.map(message => state.eventIds[message.id]))
    const review = state.titanReview
    let reviewText: string | undefined

    if (review && review.seq > after && review.seq <= through) {
      reviewText = review.block
    }

    const text = wakeText({
      titanId,
      state,
      now: Date.now(),
      reasons: [...new Set(batch.flatMap(update => wakeReasonsAt.get(update.seq) ?? []))],
      reports,
      check: batch.some(update => !reportSeqs.has(update.seq)) || !reports.length,
      review: reviewText,
      reviewId: reviewText && review ? readChanges({
        titanId,
        seqs: [review.seq],
      })[0]?.id : undefined,
    })

    return wakeMain({
      id: wakeId({
        through,
        state,
      }),
      text,
      tasks: batch.map(update => update.card),
    })
  }

  const finishReading = () => {
    const unread = updates.filter(update => update.seq > readThrough || parked.has(update.seq))

    for (const seq of wakeReasonsAt.keys()) {
      if (seq <= readThrough && !parked.has(seq)) {
        wakeReasonsAt.delete(seq)
      }
    }

    if (unread.length !== updates.length) {
      updates = unread
      queued()
    }
  }

  // Titan's turn stopped working; the parked updates a finished turn read leave the queue.
  const turnEnded = ({ activity }: { activity: string }) => {
    mainTasks.clear()

    if (activity === 'finished' && readingParked.length) {
      const done = new Set(readingParked)
      updates = updates.filter(update => !done.has(update.seq))

      for (const seq of done) {
        parked.delete(seq)
      }

      queued()
    }

    readingParked = []
  }

  const handBack = () => {
    readThrough = wakeCursor({
      state: loadTitan({ titanId }).state,
      fallback: wakeStart ?? 0,
    })
    queued()
  }

  // A wake's turn reads the updates through the seq its id names.
  const readWake = ({ id }: { id: string }) => {
    const wakeThroughSeq = WAKE_ID.exec(id)?.[1]

    if (wakeThroughSeq) {
      readThrough = Number(wakeThroughSeq)
      readingParked = wakeParked.get(readThrough) ?? []
      wakeParked.delete(readThrough)
      queued()
    }
  }

  const startFrom = ({ after }: { after: number }) => {
    wakeStart = after
    readThrough = after
  }

  const wake: Host['wake'] = ({
    seq,
    card,
    reasons,
    event,
  }) => {
    wakeStart ??= seq - 1
    wakeReasonsAt.set(
      seq,
      reasons,
    )
    wakeThrough = Math.max(
      wakeThrough,
      seq,
    )

    if (!updates.some(update => update.seq === seq)) {
      const state = loadTitan({ titanId }).state
      const kinds = event ? eventReasons({
        state,
        event,
      }).map(reason => reason.kind) : []
      const report = event?.type === 'titan.message'
      updates.push({
        seq,
        card: report ? event.data.task ?? card : card,
        kind: report ? event.data.kind ?? 'report' : [...new Set(kinds)].join(', ') || 'update',
      })
      queued()
    }

    armWake()
  }

  const unread: Host['unread'] = ({ seq }) => {
    wakeStart ??= seq - 1
  }

  const queue: Host['queue'] = () => {
    const state = loadTitan({ titanId }).state

    return {
      waiting: [
        ...updates.filter(update => update.seq > readThrough),
        ...(state.upgrades ?? []).filter(operation => operation.state === 'queued').map(operation => ({
          seq: state.eventIds[`${operation.id}:hosted`] ?? state.seq,
          card: TITAN_CARD,
          kind: 'upgrade',
        })),
      ],
      reading: updates.filter(update => update.seq <= readThrough),
    }
  }

  return {
    mainTasks,
    wakeTasks,
    wakeMain,
    armWake,
    routeUpdates,
    finishReading,
    turnEnded,
    readThrough: () => readThrough,
    handBack,
    readWake,
    startFrom,
    wakeStart: () => wakeStart,
    wake,
    unread,
    queue,
    close: () => clearTimeout(wakeTimer),
  }
}
