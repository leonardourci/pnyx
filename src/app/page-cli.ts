import { COMMON, guard, parse, type Options } from './cli-support.ts'
import type { TitanState } from './model.ts'
import { loadTitan } from './store.ts'
import { pageState, type PageInterest } from './page-state.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { projectGroups } from '#projects/groups.ts'
import { taskProjectGroup } from '#tasks/order.ts'
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
  state: TitanState
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

function pageOutput({
  state,
  args,
}: {
  state: TitanState
  args: string[]
}) {
  const {
    values,
    titanId,
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
  const counts = new Map<string, number>()

  for (const card of cards) {
    if (card.id === TITAN_CARD || !liveTask({ card })) {
      continue
    }

    const group = taskProjectGroup({
      state,
      card,
    })
    counts.set(
      group,
      (counts.get(group) ?? 0) + 1,
    )
  }

  return {
    seq: page.seq,
    columns: projectGroups({ state }).map(column => ({
      column: column.id,
      cards: counts.get(column.id) ?? 0,
    })),
    opened: opened.length ? opened : 'none: no --card given',
    hidden: interest.hidden ? cards.filter(card => !liveTask({ card })).length : 'not included; pass --hidden',
    ownerMessage: page.hydraOwnerMessage?.id ?? 'none: the owner has not messaged Titan',
    unavailable: unavailable.length ? unavailable : 'none: every card found',
    help: [
      `Use the UI to inspect the full Titan ${titanId}`,
      `Read titan.log and tasks/<task>/task.log in Titan ${titanId}`,
    ],
  }
}

export const page = guard({
  handler: ({ args }) => pageOutput({
    state: loadTitan({ titanId: parsePage({ args }).titanId }).state,
    args,
  }),
})
