import type { ResultType, TypedView, Zero } from '@rocicorp/zero'
import type { HydraState } from '#app/model.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { Settings } from '#settings/model.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { queries } from '#store/zero-schema.ts'
import { hydraFromRows, type CardRow, type DetailRow, type HydraRow, type MessageRow, type ReferenceRow } from './hydra-rows.ts'

type Watched<Data> = {
  data: Data
  loaded: boolean
  destroy(): void
}

// A view counts as loaded once Zero has its rows from this session or a cached one.
function watch<Data>({
  view,
  changed,
}: {
  view: TypedView<Data>
  changed(): void
}): Watched<Data> {
  const watched: Watched<Data> = {
    data: view.data,
    loaded: false,
    destroy: () => view.destroy(),
  }

  view.addListener((
    data,
    resultType: ResultType,
  ) => {
    watched.data = data as Data
    watched.loaded = resultType === 'complete' || resultType === 'cached'
    changed()
  })

  return watched
}

// The open Hydra's data on the page: its row, board cards, task references, messages, Hydra's own card and
// the cards opened outside the board. Changes from one write publish once.
export function watchHydra({
  zero,
  hydraId,
  publish,
}: {
  zero: Zero
  hydraId: string
  publish({
    state,
    queue,
  }: {
    state: HydraState
    queue: HydraQueue
  }): void
}) {
  let scheduled = false
  let queue: HydraQueue | undefined
  let closed = false
  let state: HydraState | undefined
  // Opened cards waiting for Zero to load them, with the page's request to answer.
  let pending: {
    ids: string[]
    resolve({ unavailable }: { unavailable: string[] }): void
  }[] = []

  const update = () => {
    if (scheduled || closed) {
      return
    }

    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const watched = [
        hydra,
        cards,
        references,
        messages,
        ...details.values(),
      ]

      if (closed || !hydra.data || watched.some(view => !view.loaded)) {
        return
      }

      const answered = pending
      pending = []

      state = hydraFromRows({
        hydra: hydra.data,
        cards: cards.data,
        opened: [...details.values()].flatMap(view => view.data ? [view.data] : []),
        references: references.data,
        messages: messages.data,
        previous: state,
      })
      // The Hydra row changes with every write; its queue keeps its identity while it reads the same.
      const next = hydra.data.queue as HydraQueue

      if (JSON.stringify(queue) !== JSON.stringify(next)) {
        queue = next
      }

      publish({
        state,
        queue: queue ?? next,
      })

      for (const {
        ids,
        resolve,
      } of answered) {
        resolve({ unavailable: ids.filter(id => !details.get(id)?.data) })
      }
    })
  }

  const hydra = watch<HydraRow | undefined>({
    view: zero.materialize(queries.hydra.one({ hydraId })),
    changed: update,
  })
  const cards = watch<readonly CardRow[]>({
    view: zero.materialize(queries.board.cards({ hydraId })),
    changed: update,
  })
  const references = watch<readonly ReferenceRow[]>({
    view: zero.materialize(queries.cards.references({ hydraId })),
    changed: update,
  })
  const messages = watch<readonly MessageRow[]>({
    view: zero.materialize(queries.hydra.messages({ hydraId })),
    changed: update,
  })
  const details = new Map<string, Watched<DetailRow | undefined>>()

  // Resolves once every opened card is loaded, naming the ones this Hydra does not have.
  const open = ({ refs }: { refs: string[] }) => {
    const ids = refs.map(ref => state?.keys[ref] ?? ref)
    const wanted = new Set([
      HYDRA_CARD,
      ...ids,
    ])

    for (const [
      id,
      view,
    ] of details) {
      if (!wanted.has(id)) {
        view.destroy()
        details.delete(id)
      }
    }

    for (const id of wanted) {
      if (!details.has(id)) {
        details.set(
          id,
          watch<DetailRow | undefined>({
            view: zero.materialize(queries.card.detail({
              hydraId,
              cardId: id,
            })),
            changed: update,
          }),
        )
      }
    }

    const loaded = new Promise<{ unavailable: string[] }>(resolve => pending.push({
      ids,
      resolve,
    }))
    update()

    return loaded
  }

  open({ refs: [] })

  return {
    open,
    close: () => {
      closed = true

      for (const view of [
        hydra,
        cards,
        references,
        messages,
        ...details.values(),
      ]) {
        view.destroy()
      }
    },
  }
}

// What every Hydra on the page shares: the Hydra list, the shared settings and the upgrade check.
export function watchInstallation({
  zero,
  hydras,
  settings,
  upgrade,
}: {
  zero: Zero
  hydras({ rows }: { rows: HydraSummary[] }): void
  upgrade({ status }: { status: UpgradeStatus | undefined }): void
  settings({
    settings,
    revision,
  }: {
    settings: Settings
    revision: number
  }): void
}) {
  const list = zero.materialize(queries.hydras.list())
  const shared = zero.materialize(queries.settings.shared())
  const checked = zero.materialize(queries.upgrade.status())
  checked.addListener(row => upgrade({
    status: row ? {
      available: row.available,
      checkedAt: row.checked_at,
    } : undefined,
  }))
  list.addListener((
    rows,
    resultType: ResultType,
  ) => {
    if (resultType === 'complete' || resultType === 'cached') {
      // Zero types the json column as plain JSON; it holds the summary the server stored.
      hydras({ rows: rows.map(row => row.summary) as HydraSummary[] })
    }
  })
  shared.addListener(row => {
    if (row) {
      settings({
        settings: row.value as Settings,
        revision: row.revision,
      })
    }
  })

  return {
    close: () => {
      list.destroy()
      shared.destroy()
      checked.destroy()
    },
  }
}
