// Folds a Firstmate home's files into a board as source observations, and keeps
// them current with fs.watch. Every write goes through the board's single writer.
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import {
  decideLink,
  decideNote,
  decideOutcome,
  decidePush,
  noteId,
  parseLink,
  type Decision,
  type Meta,
} from '../../core/decide.ts'
import type { Attention, BoardState, Card, SourceRef } from '../../core/model.ts'
import { drainSpool } from '../../cli/commands.ts'
import { withWriter, type Writer } from '../../store/board-store.ts'
import { HOOK } from '../hooks/observe.ts'
import {
  ADAPTER,
  HOME_OBJECT,
  STATUS_KEY,
  readHome,
  type HomeObservation,
  type TaskObservation,
} from './home.ts'

export interface SyncResult {
  tasks: number
  appended: number
}

const source = (home: string, objectId: string): SourceRef => ({
  adapter: ADAPTER,
  instanceId: home,
  objectId,
})

// The Firstmate source ref of a card, if it has one.
export function firstmateRef(card: Card): SourceRef | undefined {
  return card.sourceRefs.find(r => r.adapter === ADAPTER)
}

// Open decisions, plus the latest status line when it says the task failed or is
// blocked and no open decision carries it. A task closed in the backlog drops the
// latest line's attention, even when it is an open decision.
function attention(task: TaskObservation): Attention[] {
  const open = task.decisions.map(d => ({
    kind: d.verb,
    key: d.key,
    blocking: true,
    ...(d.note ? { text: d.note } : {}),
  }))
  const stalled = task.stalled

  if (!stalled) {
    return open
  }

  const carries = (a: Attention) =>
    a.kind === stalled.verb && a.text === (stalled.note || undefined)

  if (task.done) {
    return open.filter(a => !carries(a))
  }

  if (open.some(carries)) {
    return open
  }

  return [
    ...open,
    {
      kind: stalled.verb,
      key: STATUS_KEY,
      blocking: true,
      ...(stalled.note ? { text: stalled.note } : {}),
    },
  ]
}

// The attention a joined hook session opened on the card, which sync leaves alone.
function hookAttention(state: BoardState, key: string): Attention[] {
  return state.cards[state.keys[key] ?? '']?.attention.filter(a => a.key.startsWith(HOOK)) ?? []
}

function taskCard(
  home: HomeObservation,
  task: TaskObservation,
  kept: Attention[],
  current: Card | undefined,
): Record<string, unknown> {
  return {
    title: task.title,
    tags: task.repo ? [task.repo] : [],
    parent: home.key,
    ...(task.activity ? { activity: task.activity } : {}),
    // A pool reuses worktrees, so a closed task gives its folder up for the next one.
    folder: task.worktree && !task.done ? task.worktree : null,
    // The task's own terminal tells it apart from another task in the same worktree
    // and lets the session in it join, including a respawned worker's. A joined
    // session's own facts stay unless its Paseo terminal is no longer the task's.
    ...(task.paseoTerminal && task.paseoTerminal !== current?.terminal?.paseoTerminal
      && (!current?.agent || current.terminal?.paseoTerminal)
      ? { terminal: { paseoTerminal: task.paseoTerminal } }
      : {}),
    attention: [...attention(task), ...kept],
    source: source(home.path, task.task),
  }
}

// The link to record for the task's pull request, or null when the card already
// has what Firstmate knows. Firstmate adds the link as open and later marks it
// merged from the backlog; it never overwrites a state another source refreshed.
function prLink(state: BoardState, key: string, task: TaskObservation, at: string) {
  if (!task.pr) {
    return null
  }

  const current = state.cards[state.keys[key] ?? '']?.links.find(l => l.url === task.pr)

  if (current && (current.state === 'merged' || !task.merged)) {
    return null
  }

  return parseLink({ url: task.pr, state: task.merged ? 'merged' : 'open', checkedAt: at })
}

function apply(writer: Writer, decision: Decision): number {
  if (!('event' in decision)) {
    return 0
  }

  writer.append(decision.event)

  return 1
}

// Reconciles the board with the home's current files. Unchanged facts append
// nothing, so syncing twice is a no-op. A task whose records are gone keeps its
// card but drops its open decisions, since nothing can answer them any more, and
// its folder.
export function syncHome(board: string, home: string, at = new Date().toISOString()): SyncResult {
  const observed = readHome(home)
  const meta: Meta = { at, actor: ADAPTER }

  return withWriter(board, writer => {
    drainSpool(writer)
    let appended = apply(writer, decidePush(
      writer.state,
      observed.key,
      { title: observed.title, tags: [ADAPTER], source: source(home, HOME_OBJECT) },
      meta,
    ))

    for (const task of observed.tasks) {
      const key = `${observed.key}:${task.task}`
      const card = taskCard(observed, task, hookAttention(writer.state, key), writer.state.cards[writer.state.keys[key] ?? ''])
      appended += apply(writer, decidePush(writer.state, key, card, meta))
      const link = prLink(writer.state, key, task, at)

      if (link) {
        appended += apply(writer, decideLink(writer.state, key, link.url, link, meta))
      }

      // Closed in Firstmate's backlog: done, or failed when its last line was failed:.
      // A done: status line alone is often a handoff. An outcome Firstmate recorded
      // follows the backlog; one recorded by hand is left alone.
      const current = writer.state.cards[writer.state.keys[key]!]!.outcome

      if (current ? current.source === ADAPTER : task.done) {
        const outcome = !task.done
          ? null
          : task.stalled?.verb === 'failed'
            ? { state: 'failed' as const, note: 'closed after failure', closed: true }
            : { state: 'done' as const }
        appended += apply(writer, decideOutcome(writer.state, key, outcome, meta, ADAPTER))
      }

      for (const { ref, ...note } of task.notes) {
        appended += apply(
          writer,
          decideNote(writer.state, key, note, { ...meta, id: noteId(key, ref) }),
        )
      }
    }

    const live = new Set(observed.tasks.map(t => t.task))

    for (const card of Object.values(writer.state.cards)) {
      const ref = firstmateRef(card)

      if (
        !ref
        || ref.instanceId !== home
        || ref.objectId === HOME_OBJECT
        || live.has(ref.objectId)
      ) {
        continue
      }

      const kept = hookAttention(writer.state, card.key)

      if (card.attention.length === kept.length && !card.folder) {
        continue
      }

      // Its worktree goes back to the pool too, so the next task there can claim it.
      appended += apply(
        writer,
        decidePush(writer.state, card.key, { attention: kept, folder: null, source: ref }, meta),
      )
    }

    return { tasks: observed.tasks.length, appended }
  })
}

export interface HomeWatch {
  close(): void
}

// Files whose change can alter an observation; the home's other state files are
// locks and queues that churn constantly.
const RELEVANT = /\.(meta|status)$|^backlog\.md$/
const SETTLE_MS = 50
const RETRY_MS = 1000

// Syncs once, then again after each relevant change under state/ and data/.
// Bursts coalesce into one sync. A watcher error re-creates the watchers and
// resyncs, so a dropped event cannot leave the board behind. No polling.
export function watchHome(
  board: string,
  home: string,
  onSync: (result: SyncResult | Error) => void,
): HomeWatch {
  let watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | undefined
  let closed = false

  const sync = () => {
    timer = undefined

    if (closed) {
      return
    }

    try {
      onSync(syncHome(board, home))
    } catch (error) {
      onSync(error as Error)
      // A locked board or a half-written file clears on its own; try once more later.
      schedule(RETRY_MS)
    }
  }

  const schedule = (ms = SETTLE_MS) => {
    if (!closed && !timer) {
      timer = setTimeout(sync, ms)
    }
  }

  const start = () => {
    for (const w of watchers) {
      w.close()
    }

    watchers = []

    for (const dir of ['state', 'data']) {
      try {
        const w = watch(join(home, dir), (_type, file) => {
          if (!file || RELEVANT.test(String(file))) {
            schedule()
          }
        })
        w.on('error', () => {
          if (closed) {
            return
          }

          start()
          schedule()
        })
        watchers.push(w)
      } catch {
        // data/ is optional; a home without a backlog still has tasks.
      }
    }
  }

  start()
  sync()

  return {
    close() {
      closed = true
      clearTimeout(timer)

      for (const w of watchers) {
        w.close()
      }
    },
  }
}
