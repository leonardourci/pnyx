import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { hydraConfig, declareTask, hydraEvent } from '../../core/hydra.ts'
import { parseStatusLine } from './status.ts'
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
import type { Attention, HydraState, Card, SourceRef } from '../../core/model.ts'
import { drainSpool } from '../hooks/ingest.ts'
import { withWriter, type Writer } from '../../store/hydra-store.ts'
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
  // Set when the Hydra is another identity, so this home was not mirrored.
  ignored?: string
}

const source = ({ home, objectId }: { home: string; objectId: string }): SourceRef => ({
  adapter: ADAPTER,
  instanceId: home,
  objectId,
})

export function firstmateRef({ card }: { card: Card }): SourceRef | undefined {
  return card.sourceRefs.find(r => r.adapter === ADAPTER)
}

// Open decisions, plus the latest status line when it says the task failed or is
// blocked and no open decision carries it. A task closed in the backlog drops the
// latest line's attention, even when it is an open decision.
function attention({ task }: { task: TaskObservation }): Attention[] {
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

  const carries = ({ a }: { a: Attention }) =>
    a.kind === stalled.verb && a.text === (stalled.note || undefined)

  if (task.done) {
    return open.filter(a => !carries({ a }))
  }

  if (open.some(a => carries({ a }))) {
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

function hookAttention({ state, key }: { state: HydraState; key: string }): Attention[] {
  return state.cards[state.keys[key] ?? '']?.attention.filter(a => a.key.startsWith(HOOK)) ?? []
}

function taskCard(
  { home, task, kept, current }: {
    home: HomeObservation
    task: TaskObservation
    kept: Attention[]
    current: Card | undefined
  },
): Record<string, unknown> {
  return {
    title: task.title,
    tags: task.repo ? [task.repo] : [],
    // Hydra may nest the task under the Hydra task it serves; that placement stays.
    ...(current?.parentId ? {} : { parent: null }),
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
    attention: [...attention({ task }), ...kept],
    source: source({ home: home.path, objectId: task.task }),
  }
}

// The link to record for the task's pull request, or null when the card already
// has what Firstmate knows. Firstmate adds the link as open and later marks it
// merged from the backlog; it never overwrites a state another source refreshed.
function prLink({ state, key, task, at }: {
  state: HydraState
  key: string
  task: TaskObservation
  at: string
}) {
  if (!task.pr) {
    return null
  }

  const current = state.cards[state.keys[key] ?? '']?.links.find(l => l.url === task.pr)

  if (current && (current.state === 'merged' || !task.merged)) {
    return null
  }

  return parseLink({ input: { url: task.pr, state: task.merged ? 'merged' : 'open', checkedAt: at } })
}

function apply({ writer, decision }: { writer: Writer; decision: Decision }): number {
  if (!('event' in decision)) {
    return 0
  }

  writer.append({ event: decision.event })

  return 1
}

// Reconciles the Hydra with the home's current files. Unchanged facts append
// nothing, so syncing twice is a no-op. A task whose records are gone keeps its
// card but drops its open decisions, since nothing can answer them any more, and
// its folder.
export function syncHome({ hydraId, home, at = new Date().toISOString() }: {
  hydraId: string
  home: string
  at?: string
}): SyncResult {
  const observed = readHome({ home })
  const meta: Meta = { at, actor: ADAPTER }

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })

      if (writer.state.configured && (writer.state.config!.hydra.kind !== 'firstmate' || writer.state.config!.hydra.home !== home)) {
        return { tasks: 0, appended: 0, ignored: `Hydra ${hydraId} has Hydra ${writer.state.config!.hydra.id}, not this home` }
      }

      let configured = 0

      if (!writer.state.configured) {
        const config = hydraConfig({ state: writer.state, id: hydraId })
        configured = apply({ writer, decision: hydraEvent({ state: writer.state, meta, cardId: '$board', change: { type: 'board.configured', data: { ...config, hydra: { id: observed.key, name: 'Hydra', kind: 'firstmate', home } } } }) })
      }

      let appended = apply({
        writer,
        decision: decidePush(
          {
            state: writer.state,
            key: observed.key,
            input: {
              title: observed.title,
              tags: [ADAPTER],
              source: source({ home, objectId: HOME_OBJECT }),
            },
            meta,
          },
        ),
      })
      appended += configured

      for (const task of observed.tasks) {
        const key = `${observed.key}:${task.task}`
        const card = taskCard({
          home: observed,
          task,
          kept: hookAttention({
            state: writer.state,
            key,
          }),
          current: writer.state.cards[writer.state.keys[key] ?? ''],
        })
        appended += apply({
          writer,
          decision: decidePush({ state: writer.state, key, input: card, meta }),
        })
        const mirrored = writer.state.cards[writer.state.keys[key]!]!

        const record = {
          ...task.record,
          meta: task.record.present?.meta
            ? task.record.meta : mirrored.mirror?.meta ?? task.record.meta,
          status: task.record.present?.status
            ? task.record.status : mirrored.mirror?.status ?? task.record.status,
        }

        if (!isDeepStrictEqual(mirrored.mirror, record)) {
          appended += apply({ writer, decision: hydraEvent({ state: writer.state, meta, cardId: mirrored.id, change: { type: 'task.mirrored', data: record } }) })
        }

        const states: Record<string, string> = { working: 'working', 'needs-decision': 'needs_you', 'needs-you': 'needs_you', paused: 'paused', blocked: 'blocked', failed: 'blocked', done: 'done' }

        let declared: string | undefined

        for (const [index, raw] of task.record.status.split('\n').entries()) {
          const line = parseStatusLine({ line: raw })
          const status = states[line.verb]

          if (!line.colon || !status || line.key === null) {
            continue
          }

          const stamp = /\[at=(\d+)\]/.exec(raw)?.[1]
          const timestamp = stamp ? new Date(Number(stamp) * 1000) : undefined
          const id = noteId({ cardKey: key, ref: `declaration:${index}:${raw}` })
          declared = status
          const validTime = timestamp && Number.isFinite(timestamp.getTime())
          const declarationMeta = {
            ...meta,
            id,
            ...(validTime ? { at: timestamp.toISOString() } : {}),
          }
          appended += apply({
            writer,
            decision: declareTask({
              state: writer.state,
              ref: key,
              status,
              note: line.note,
              meta: declarationMeta,
              source: ADAPTER,
              raw,
            }),
          })
        }

        const currentStatus = writer.state.cards[mirrored.id]!.status?.state
        const expected = task.done ? 'done' : task.decisions.length ? 'needs_you' : declared ?? 'paused'

        if (expected && expected !== currentStatus) {
          const note = task.done ? 'Closed in Firstmate backlog'
            : task.decisions.length ? 'Firstmate has unresolved decisions'
              : declared ? 'Latest Firstmate status declaration' : 'No active Firstmate worker declaration'
          appended += apply({
            writer,
            decision: declareTask({
              state: writer.state,
              ref: key,
              status: expected,
              note,
              meta,
              source: ADAPTER,
            }),
          })
        }

        const link = prLink({ state: writer.state, key, task, at })

        if (link) {
          appended += apply({
            writer,
            decision: decideLink({
              state: writer.state,
              ref: key,
              url: link.url,
              link,
              meta,
            }),
          })
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
          appended += apply({
            writer,
            decision: decideOutcome({
              state: writer.state,
              ref: key,
              outcome,
              meta,
              source: ADAPTER,
            }),
          })
        }

        for (const { ref, ...note } of task.notes) {
          appended += apply(
            {
              writer,
              decision: decideNote({
                state: writer.state,
                ref: key,
                note,
                meta: {
                  ...meta,
                  id: noteId({
                    cardKey: key,
                    ref,
                  }),
                },
              }),
            },
          )
        }
      }

      const live = new Set(observed.tasks.map(t => t.task))

      for (const card of Object.values(writer.state.cards)) {
        const ref = firstmateRef({ card })

        if (
          !ref
        || ref.instanceId !== home
        || ref.objectId === HOME_OBJECT
        || live.has(ref.objectId)
        ) {
          continue
        }

        const kept = hookAttention({ state: writer.state, key: card.key })

        if (card.attention.length === kept.length && !card.folder) {
          continue
        }

        appended += apply(
          {
            writer,
            decision: decidePush({
              state: writer.state,
              key: card.key,
              input: {
                attention: kept,
                folder: null,
                source: ref,
              },
              meta,
            }),
          },
        )
      }

      return { tasks: observed.tasks.length, appended }
    },
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

export function watchHome(
  { hydraId, home, onSync }: {
    hydraId: string
    home: string
    onSync: (
      { result }: {
        result: SyncResult | Error
      },
    ) => void
  },
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
      onSync({ result: syncHome({ hydraId, home }) })
    } catch (error) {
      onSync({ result: error as Error })
      // A locked Hydra or a half-written file clears on its own; try once more later.
      schedule({ ms: RETRY_MS })
    }
  }

  const schedule = ({ ms = SETTLE_MS }) => {
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
            schedule({})
          }
        })
        w.on('error', () => {
          if (closed) {
            return
          }

          start()
          schedule({})
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
