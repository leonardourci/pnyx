import type { ResultType, TypedView, Zero } from '@rocicorp/zero'
import type { HydraState } from '#app/model.ts'
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
  publish({ state }: { state: HydraState }): void
}) {
  let scheduled = false
  let closed = false
  let state: HydraState | undefined

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

      state = hydraFromRows({
        hydra: hydra.data,
        cards: cards.data,
        opened: [...details.values()].flatMap(view => view.data ? [view.data] : []),
        references: references.data,
        messages: messages.data,
        previous: state,
      })
      publish({ state })
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

  const open = ({ ids }: { ids: string[] }) => {
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

    update()
  }

  open({ ids: [] })

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
