import { COMMON, guard, parse, type Options } from './cli-support.ts'
import type { HydraState } from './model.ts'
import { loadHydra } from './store.ts'
import { pageState, type PageInterest } from './page-state.ts'
import { hydraConfig } from '#hydra/config.ts'
import { liveTask } from '#tasks/select.ts'

const PAGE_OPTIONS: Options = {
  ...COMMON,
  card: {
    type: 'string',
    multiple: true,
  },
  hidden: { type: 'boolean' },
  full: { type: 'boolean' },
}

export function parsePage({ args }: { args: string[] }) {
  return parse({
    args,
    options: PAGE_OPTIONS,
    positionals: 0,
  })
}

export function pageInterest({
  state,
  values,
}: {
  state: HydraState
  values: ReturnType<typeof parsePage>['values']
}): {
  interest: PageInterest
  opened: {
    id: string
    title: string
  }[]
  unavailable: string[]
} {
  const refs = Array.isArray(values.card) ? values.card : []
  const opened: {
    id: string
    title: string
  }[] = []
  const unavailable: string[] = []

  for (const ref of refs) {
    const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

    if (card) {
      opened.push({
        id: card.id,
        title: card.title,
      })
    } else {
      unavailable.push(ref)
    }
  }

  return {
    interest: {
      cards: opened.map(card => card.id),
      hidden: values.hidden === true,
    },
    opened,
    unavailable,
  }
}

export function pageOutput({
  state,
  args,
}: {
  state: HydraState
  args: string[]
}) {
  const {
    values,
    hydraId,
  } = parsePage({ args })
  const {
    interest,
    opened,
    unavailable,
  } = pageInterest({
    state,
    values,
  })
  const page = pageState({
    state,
    interest,
  })

  if (values.full === true) {
    return {
      page,
      unavailable,
    }
  }

  const cards = Object.values(page.cards)

  return {
    seq: page.seq,
    columns: hydraConfig({ state }).columns.map(column => ({
      column: column.id,
      cards: cards.filter(card => liveTask({ card }) && card.column === column.id).length,
    })),
    opened: opened.length ? opened : 'none: no --card given',
    hidden: interest.hidden ? cards.filter(card => !liveTask({ card })).length : 'not included; pass --hidden',
    ownerMessage: page.hydraOwnerMessage?.id ?? 'none: the owner has not messaged Hydra',
    unavailable: unavailable.length ? unavailable : 'none: every card found',
    help: [
      `Run \`pnyx-axi page --full --hydra ${hydraId}\` for the server's whole page projection`,
      `Run \`pnyx-axi card <id> --hydra ${hydraId}\` or \`pnyx-axi task list --hydra ${hydraId}\` to read tasks`,
    ],
  }
}

export const page = guard({
  handler: ({ args }) => pageOutput({
    state: loadHydra({ hydraId: parsePage({ args }).hydraId }).state,
    args,
  }),
})
