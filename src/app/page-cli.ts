import { COMMON, guard, parse } from './cli-support.ts'
import type { HydraState } from './model.ts'
import { loadHydra } from './store.ts'
import { pageState, type PageInterest } from './page-state.ts'

export function pageInterest({
  state,
  args,
}: {
  state: HydraState
  args: string[]
}): PageInterest {
  const { values } = parse({
    args,
    options: {
      ...COMMON,
      card: {
        type: 'string',
        multiple: true,
      },
      hidden: { type: 'boolean' },
    },
    positionals: 0,
  })
  const refs = Array.isArray(values.card) ? values.card : []

  const cards: string[] = []
  const unavailable: string[] = []

  for (const ref of refs) {
    const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

    if (card) {
      cards.push(card.id)
    } else {
      unavailable.push(ref)
    }
  }

  return {
    cards,
    unavailable,
    hidden: values.hidden === true,
  }
}

export const page = guard({
  handler: ({ args }) => {
    const { hydraId } = parse({
      args,
      options: {
        ...COMMON,
        card: {
          type: 'string',
          multiple: true,
        },
        hidden: { type: 'boolean' },
      },
      positionals: 0,
    })
    const state = loadHydra({ hydraId }).state
    const interest = pageInterest({
      state,
      args,
    })

    return {
      page: pageState({
        state,
        interest,
      }),
      unavailable: interest.unavailable ?? [],
    }
  },
})
