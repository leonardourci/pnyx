import type { ErroredQuery, ResultType, TypedView, Zero } from '@rocicorp/zero'
import type { HydraState } from '#app/model.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { Settings } from '#settings/model.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { emptyHydra } from '#app/reducer.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { queries } from '#store/zero-schema.ts'
import { hydraFromRows, type CardRow, type DetailRow, type HydraRow, type MessageRow, type ReferenceRow } from './hydra-rows.ts'

type Watched<Data> = {
  data: Data
  loaded: boolean
  error?: string
  destroy(): void
}

const HYDRA_ERROR = 'Zero could not read this Hydra'
const INSTALLATION_ERROR = 'Zero could not read the Hydra list or shared settings'

const loadedResult = ({ resultType }: { resultType: ResultType }) => resultType === 'complete' || resultType === 'cached'

// A view has its answer once it loaded or failed.
const settled = ({ view }: { view: Watched<unknown> }) => view.loaded || view.error !== undefined

// The Hydra row's queue reads '{}' until the server first writes it.
function queueOf({ stored }: { stored: unknown }): HydraQueue {
  const field = ({ name }: { name: keyof HydraQueue }) =>
    typeof stored === 'object' && stored !== null ? Reflect.get(
      stored,
      name,
    ) : undefined
  const waiting = field({ name: 'waiting' })
  const reading = field({ name: 'reading' })

  return {
    chat: field({ name: 'chat' }) ?? undefined,
    waiting: Array.isArray(waiting) ? waiting : [],
    reading: Array.isArray(reading) ? reading : [],
  }
}

// A row the server just inserted holds '{}' until it writes the summary, so only a row with an id lists a Hydra.
function summaryOf({ stored }: { stored: unknown }): HydraSummary[] {
  const listed = typeof stored === 'object' && stored !== null && typeof Reflect.get(
    stored,
    'id',
  ) === 'string'

  return listed ? [stored as HydraSummary] : []
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
    error?: ErroredQuery,
  ) => {
    watched.data = data as Data
    watched.loaded = loadedResult({ resultType })
    watched.error = resultType === 'error' ? error?.message ?? HYDRA_ERROR : undefined
    changed()
  })

  return watched
}

// The open Hydra's data on the page: its row, board cards, task references, the owner's latest message, Hydra's own card and
// the cards opened outside the board. Changes from one write publish once; an opened card joins once its detail loads.
export function watchHydra({
  zero,
  hydraId,
  publish,
  failed,
}: {
  zero: Zero
  hydraId: string
  failed({ message }: { message: string }): void
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
  const missing = emptyHydra()
  // The cards the page opened, by id or key, and its requests waiting for Zero to load them.
  let opened: string[] = []
  let pending: {
    refs: string[]
    resolve({ unavailable }: { unavailable: string[] }): void
  }[] = []

  // A ref is a card's id or key; one no row has yet, such as a task still being created, resolves to nothing.
  const resolved = ({ ref }: { ref: string }) =>
    references.data.find(row => row.id === ref || row.key === ref)?.id

  // Each opened card that resolves gets its detail view; Hydra's own card always has one.
  const sync = () => {
    const wanted = new Set([
      HYDRA_CARD,
      ...opened.flatMap(ref => resolved({ ref }) ?? []),
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
  }

  const update = () => {
    if (scheduled || closed) {
      return
    }

    scheduled = true
    queueMicrotask(() => {
      scheduled = false

      if (closed) {
        return
      }

      if (references.loaded) {
        sync()
      }

      const board = [
        hydra,
        cards,
        references,
        ownerMessage,
      ]
      const error = [
        ...board,
        ...details.values(),
      ].find(view => view.error)?.error
      const hydraCard = details.get(HYDRA_CARD)
      const hydraCardSettled = hydraCard !== undefined && settled({ view: hydraCard })
      const boardLoaded = board.every(view => view.loaded) && hydraCardSettled

      if (boardLoaded) {
        show()
      }

      // After the publish, which clears an earlier load error.
      if (error) {
        failed({ message: error })
      }
    })
  }

  const viewOf = ({ ref }: { ref: string }) => {
    const id = resolved({ ref })

    return id ? details.get(id) : undefined
  }

  // A Hydra with no row yet has had no events, so it shows empty.
  const show = () => {
    state = hydra.data ? hydraFromRows({
      hydra: hydra.data,
      cards: cards.data,
      opened: [...details.values()].flatMap(view => view.loaded && view.data ? [view.data] : []),
      references: references.data,
      ownerMessage: ownerMessage.data,
      previous: state,
    }) : missing
    // The Hydra row changes with every write; its queue keeps its identity while it reads the same.
    const next = queueOf({ stored: hydra.data?.queue })

    if (JSON.stringify(queue) !== JSON.stringify(next)) {
      queue = next
    }

    publish({
      state,
      queue: queue ?? next,
    })

    const waiting = pending
    pending = []

    for (const request of waiting) {
      const views = request.refs.flatMap(ref => viewOf({ ref }) ?? [])

      if (!views.every(view => settled({ view }))) {
        pending.push(request)
        continue
      }

      // A card whose detail failed is reported as the Hydra's error, not as missing.
      request.resolve({
        unavailable: request.refs.filter(ref => {
          const view = viewOf({ ref })

          return !view?.data && view?.error === undefined
        }),
      })
    }
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
  const ownerMessage = watch<MessageRow | undefined>({
    view: zero.materialize(queries.hydra.ownerMessage({ hydraId })),
    changed: update,
  })
  const details = new Map<string, Watched<DetailRow | undefined>>()

  // Resolves once every opened card is loaded, naming the refs this Hydra has no card for.
  const open = ({ refs }: { refs: string[] }) => {
    opened = refs
    const loaded = new Promise<{ unavailable: string[] }>(resolve => pending.push({
      refs,
      resolve,
    }))
    update()

    return loaded
  }

  update()

  return {
    open,
    close: () => {
      closed = true

      // Nothing loads once closed, so a waiting request learns nothing is missing and moves on.
      for (const { resolve } of pending) {
        resolve({ unavailable: [] })
      }

      pending = []

      for (const view of [
        hydra,
        cards,
        references,
        ownerMessage,
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
  failure,
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
  // The first error these views have now, or none once they read again.
  failure({ message }: { message?: string }): void
}) {
  const errors = new Map<string, string>()
  let reported: string | undefined

  const report = ({
    name,
    resultType,
    error,
  }: {
    name: string
    resultType: ResultType
    error?: ErroredQuery
  }) => {
    if (resultType === 'error') {
      errors.set(
        name,
        error?.message ?? INSTALLATION_ERROR,
      )
    } else {
      errors.delete(name)
    }

    const message = errors.values().next().value

    if (message !== reported) {
      reported = message
      failure({ message })
    }
  }

  const list = zero.materialize(queries.hydras.list())
  const shared = zero.materialize(queries.settings.shared())
  const checked = zero.materialize(queries.upgrade.status())
  checked.addListener((
    row,
    resultType: ResultType,
    error?: ErroredQuery,
  ) => {
    report({
      name: 'upgrade',
      resultType,
      error,
    })

    if (resultType !== 'error') {
      upgrade({
        status: row ? {
          available: row.available,
          checkedAt: row.checked_at,
        } : undefined,
      })
    }
  })
  list.addListener((
    rows,
    resultType: ResultType,
    error?: ErroredQuery,
  ) => {
    report({
      name: 'hydras',
      resultType,
      error,
    })

    if (loadedResult({ resultType })) {
      hydras({ rows: rows.flatMap(row => summaryOf({ stored: row.summary })) })
    }
  })
  shared.addListener((
    row,
    resultType: ResultType,
    error?: ErroredQuery,
  ) => {
    report({
      name: 'settings',
      resultType,
      error,
    })

    if (row && resultType !== 'error') {
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
