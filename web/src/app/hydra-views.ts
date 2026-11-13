import type { ConnectionState, ErroredQuery, ResultType, TypedView, Zero } from '@rocicorp/zero'
import type { HydraState } from '#app/model.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { Settings } from '#settings/model.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { emptyHydra } from '#app/reducer.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { queries } from '#store/zero-schema.ts'
import { inListOrder } from '#app/hydra-list-order.ts'
import { kept } from '#web-shared/stable.ts'
import { hydraFromRows, type DetailRow } from './hydra-rows.ts'

type Watched<Data> = {
  data: Data
  loaded: boolean
  error?: string
  // Builds the view again when it failed; a Zero view that reported an error never reads again.
  retry(): void
  destroy(): void
}

const HYDRA_ERROR = 'Could not read this Hydra'
const INSTALLATION_ERROR = 'Could not read the Hydra list or shared settings'

// A view has its answer once it loaded or failed.
const settled = ({ view }: { view: Watched<unknown> }) => view.loaded || view.error !== undefined

// A Hydra with no row yet has nothing queued.
const NOTHING_QUEUED: HydraQueue = {
  waiting: [],
  reading: [],
}

// A view counts as loaded once Zero has its rows from this session or a cached one.
function watch<Data>({
  open,
  failure,
  changed,
}: {
  open(): TypedView<Data>
  // The message for an error Zero gives no message for.
  failure: string
  changed({ view }: { view: Watched<Data> }): void
}): Watched<Data> {
  let view: TypedView<Data>

  const start = () => {
    view = open()
    watched.data = view.data
    watched.loaded = false
    watched.error = undefined
    view.addListener((
      data,
      resultType: ResultType,
      error?: ErroredQuery,
    ) => {
      watched.data = data as Data
      watched.loaded = resultType === 'complete' || resultType === 'cached'
      watched.error = resultType === 'error' ? error?.message ?? failure : undefined
      changed({ view: watched })
    })
  }

  const watched: Watched<Data> = {
    data: undefined as Data,
    loaded: false,
    retry: () => {
      if (watched.error === undefined) {
        return
      }

      view.destroy()
      start()
      changed({ view: watched })
    },
    destroy: () => view.destroy(),
  }
  start()

  return watched
}

// The open Hydra's data on the page: its row, board cards, task references, the owner's latest message, Hydra's own card and
// the cards opened by id or key. Changes from one write publish once; an opened card joins once its detail loads.
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
  let queue = NOTHING_QUEUED
  let closed = false
  let state: HydraState | undefined
  const missing = emptyHydra()
  // The cards the page opened, by id or key, and its requests waiting for Zero to load them.
  let opened: string[] = []
  let pending: {
    refs: string[]
    resolve({ unavailable }: { unavailable: string[] }): void
    reject({ error }: { error: Error }): void
  }[] = []

  // Hydra's own card always has a detail view, and so does each opened ref, whatever card it names.
  const sync = () => {
    const wanted = new Set([
      HYDRA_CARD,
      ...opened,
    ])

    for (const [
      ref,
      view,
    ] of details) {
      if (!wanted.has(ref)) {
        view.destroy()
        details.delete(ref)
      }
    }

    for (const ref of wanted) {
      if (!details.has(ref)) {
        details.set(
          ref,
          watch({
            open: () => zero.materialize(queries.card.detail({
              hydraId,
              ref,
            })),
            failure: HYDRA_ERROR,
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

      sync()
      const board = [
        hydra,
        cards,
        references,
        ownerMessage,
      ]
      const boardError = board.find(view => view.error)?.error
      const error = boardError ?? [...details.values()].find(view => view.error)?.error
      const hydraCard = details.get(HYDRA_CARD)!
      const boardLoaded = board.every(view => view.loaded) && settled({ view: hydraCard })

      if (boardLoaded) {
        show()
      } else if (boardError) {
        // The board shows nothing until it reads again, so a card waiting to open learns why now.
        for (const request of pending) {
          request.reject({ error: new Error(boardError) })
        }

        pending = []
      }

      // After the publish, which clears an earlier load error.
      if (error) {
        failed({ message: error })
      }
    })
  }

  // A ref whose detail settled with no card and no error names no card in this Hydra.
  const unavailable = ({ ref }: { ref: string }) => {
    const view = details.get(ref)!

    return !view.data && view.error === undefined
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
    // Zero types json columns as plain JSON; the queue column holds the HydraQueue the server wrote. The Hydra row
    // changes with every write, so the queue keeps its identity while it reads the same.
    queue = kept({
      previous: queue,
      next: (hydra.data?.queue ?? NOTHING_QUEUED) as HydraQueue,
    })

    publish({
      state,
      queue,
    })

    const waiting = pending
    pending = []

    for (const request of waiting) {
      const views = request.refs.map(ref => details.get(ref)!)

      if (!views.every(view => settled({ view }))) {
        pending.push(request)
        continue
      }

      // A card whose detail failed is reported as the Hydra's error, not as missing.
      request.resolve({ unavailable: request.refs.filter(ref => unavailable({ ref })) })
    }
  }

  const hydra = watch({
    open: () => zero.materialize(queries.hydra.one({ hydraId })),
    failure: HYDRA_ERROR,
    changed: update,
  })
  const cards = watch({
    open: () => zero.materialize(queries.board.cards({ hydraId })),
    failure: HYDRA_ERROR,
    changed: update,
  })
  const references = watch({
    open: () => zero.materialize(queries.cards.references({ hydraId })),
    failure: HYDRA_ERROR,
    changed: update,
  })
  const ownerMessage = watch({
    open: () => zero.materialize(queries.hydra.ownerMessage({ hydraId })),
    failure: HYDRA_ERROR,
    changed: update,
  })
  const details = new Map<string, Watched<DetailRow | undefined>>()
  const views = () => [
    hydra,
    cards,
    references,
    ownerMessage,
    ...details.values(),
  ]

  // Resolves once every opened card is loaded, naming the refs this Hydra has no card for; rejects when the board
  // cannot be read.
  const open = ({ refs }: { refs: string[] }) => {
    for (const request of pending) {
      request.resolve({ unavailable: [] })
    }

    pending = []
    opened = refs
    const loaded = new Promise<{ unavailable: string[] }>((
      resolve,
      reject,
    ) => pending.push({
      refs,
      resolve,
      reject: ({ error }) => reject(error),
    }))
    update()

    return loaded
  }

  update()

  return {
    open,
    retry: () => views().forEach(view => view.retry()),
    close: () => {
      closed = true

      // Nothing loads once closed, so a waiting request learns nothing is missing and moves on.
      for (const { resolve } of pending) {
        resolve({ unavailable: [] })
      }

      pending = []

      for (const view of views()) {
        view.destroy()
      }
    },
  }
}

// What every Hydra on the page shares: the Hydra list, the shared settings, the upgrade check and Zero's connection.
export function watchInstallation({
  zero,
  hydras,
  settings,
  upgrade,
  failure,
  connection,
}: {
  zero: Zero
  // Each change of Zero's connection; after `error`, `needs-auth` or `closed` it no longer tries by itself.
  connection({ state }: { state: ConnectionState['name'] }): void
  hydras({ rows }: { rows: HydraSummary[] }): void
  upgrade({ status }: { status: UpgradeStatus | undefined }): void
  settings({
    settings,
    revision,
  }: {
    settings: Settings
    revision: number
  }): void
  // The first error these views have now, or none once a retry has read them again.
  failure({ message }: { message?: string }): void
}) {
  const errors = new Map<string, string>()
  let reported: string | undefined

  const report = ({
    name,
    error,
  }: {
    name: string
    error?: string
  }) => {
    if (error === undefined) {
      errors.delete(name)
    } else {
      errors.set(
        name,
        error,
      )
    }

    const message = errors.values().next().value

    if (message !== reported) {
      reported = message
      failure({ message })
    }
  }

  const checked = watch({
    open: () => zero.materialize(queries.upgrade.status()),
    failure: INSTALLATION_ERROR,
    changed: ({ view }) => {
      report({
        name: 'upgrade',
        error: view.error,
      })

      if (view.error === undefined) {
        upgrade({
          status: view.data ? {
            available: view.data.available,
            checkedAt: view.data.checked_at,
          } : undefined,
        })
      }
    },
  })
  const list = watch({
    open: () => zero.materialize(queries.hydras.list()),
    failure: INSTALLATION_ERROR,
    changed: ({ view }) => {
      report({
        name: 'hydras',
        error: view.error,
      })

      if (view.loaded) {
        // Zero types json columns as plain JSON; each summary is the HydraSummary the server wrote.
        hydras({ rows: inListOrder({ hydras: view.data.map(row => row.summary as HydraSummary) }) })
      }
    },
  })
  const shared = watch({
    open: () => zero.materialize(queries.settings.shared()),
    failure: INSTALLATION_ERROR,
    changed: ({ view }) => {
      report({
        name: 'settings',
        error: view.error,
      })

      if (view.data && view.error === undefined) {
        settings({
          // Zero types json columns as plain JSON; the value is the Settings the server last applied.
          settings: view.data.value as Settings,
          revision: view.data.revision,
        })
      }
    },
  })
  const views = [
    checked,
    list,
    shared,
  ]

  // eslint-disable-next-line pnyx/object-params -- Zero's connection state listener contract.
  const stopWatching = zero.connection.state.subscribe(state => connection({ state: state.name }))

  return {
    // A closed client never connects again, so only a new one reads after `closed`.
    retry: () => {
      const { name } = zero.connection.state.current

      if (name === 'error' || name === 'needs-auth') {
        // A refused reconnect shows through the connection state, so its promise carries nothing more.
        zero.connection.connect().catch(() => {})
      }

      views.forEach(view => view.retry())
    },
    close: () => {
      stopWatching()
      views.forEach(view => view.destroy())
    },
  }
}
