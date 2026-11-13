import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import type { Zero } from '@rocicorp/zero'
import type { HydraState } from '#app/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { watchHydra, watchInstallation } from './hydra-views.ts'

type View = {
  name: string
  args: Record<string, string>
  destroyed: boolean
  answer({
    data,
    resultType,
    message,
  }: {
    data: unknown
    resultType: string
    message?: string
  }): void
}

// Stands in for Zero: every materialized view waits until the test answers it, and, as in Zero, a view that
// reported an error never answers again.
function fakeZero() {
  const views: View[] = []
  let state: { name: string } = { name: 'connected' }
  let connects = 0
  // eslint-disable-next-line pnyx/object-params -- Zero's connection state listener contract.
  const stateListeners: ((state: { name: string }) => void)[] = []
  const zero = {
    // eslint-disable-next-line pnyx/object-params -- Zero owns materialize's signature.
    materialize: (request: {
      query: { queryName: string }
      args: Record<string, string>
    }) => {
      // eslint-disable-next-line pnyx/object-params -- Zero's view listener contract.
      const listeners: ((
        data: unknown,
        resultType: string,
        error?: { message: string },
      ) => void)[] = []
      let errored = false
      const view: View = {
        name: request.query.queryName,
        args: request.args,
        destroyed: false,
        answer: ({
          data,
          resultType,
          message,
        }) => {
          if (errored) {
            return
          }

          errored = resultType === 'error'
          listeners.forEach(listener => listener(
            data,
            resultType,
            message === undefined ? undefined : { message },
          ))
        },
      }
      views.push(view)

      return {
        data: undefined,
        // eslint-disable-next-line pnyx/object-params -- Zero's view listener contract.
        addListener: (listener: (
          data: unknown,
          resultType: string,
        ) => void) => {
          listeners.push(listener)

          return () => {}
        },
        destroy: () => {
          view.destroyed = true
        },
      }
    },
    connection: {
      state: {
        get current() {
          return state
        },
        // eslint-disable-next-line pnyx/object-params -- Zero's connection state listener contract.
        subscribe: (listener: (state: { name: string }) => void) => {
          stateListeners.push(listener)

          return () => stateListeners.splice(
            stateListeners.indexOf(listener),
            1,
          )
        },
      },
      connect: async () => {
        connects++
      },
    },
  }

  const live = ({ name }: { name: string }) =>
    views.filter(view => view.name === name && !view.destroyed)

  return {
    zero: zero as unknown as Zero,
    views,
    live,
    detail: ({ ref }: { ref: string }) => live({ name: 'card.detail' }).find(view => view.args.ref === ref),
    connect: ({ name }: { name: string }) => {
      state = { name }
      stateListeners.forEach(listener => listener(state))
    },
    connects: () => connects,
  }
}

const reference = ({
  id,
  key,
}: {
  id: string
  key: string
}) => ({
  id,
  key,
  title: id,
  column_id: 'working',
  hidden: true,
  automatic_task: false,
  created_seq: 1,
  updated_seq: 1,
  updated_at: '2026-11-13T00:00:00.000Z',
})

const hydraRow = {
  id: 'h',
  seq: 3,
  config: null,
  queue: {
    waiting: [],
    reading: [],
  },
  columns: [],
  values: [],
}

function answerAll({
  fake,
  references,
}: {
  fake: ReturnType<typeof fakeZero>
  references: ReturnType<typeof reference>[]
}) {
  fake.live({ name: 'hydra.one' })[0]!.answer({
    data: hydraRow,
    resultType: 'complete',
  })
  fake.live({ name: 'board.cards' })[0]!.answer({
    data: [],
    resultType: 'complete',
  })
  fake.live({ name: 'hydra.ownerMessage' })[0]!.answer({
    data: undefined,
    resultType: 'complete',
  })
  fake.live({ name: 'cards.references' })[0]!.answer({
    data: references,
    resultType: 'complete',
  })
}

const detailRow = ({ id }: { id: string }) => ({
  ...reference({
    id,
    key: id,
  }),
  child_working: false,
  wait_title: null,
  unmet_prerequisites: [],
  body: { data: { id } },
  replies: [],
  questions: [],
  declarations: [],
  links: [],
  notes: [],
})

test(
  'an opened task found by its key loads its detail, and a ref no task has comes back as missing',
  async () => {
    const fake = fakeZero()
    const states: HydraState[] = []
    const watched = watchHydra({
      zero: fake.zero,
      hydraId: 'h',
      publish: ({ state }) => states.push(state),
      failed: () => {},
    })
    const opened = watched.open({
      refs: [
        'ship',
        'nothing-here',
      ],
    })
    answerAll({
      fake,
      references: [],
    })
    await setImmediate()
    fake.detail({ ref: 'ship' })!.answer({
      data: {
        ...detailRow({ id: 'task-1' }),
        key: 'ship',
      },
      resultType: 'complete',
    })
    fake.detail({ ref: 'nothing-here' })!.answer({
      data: undefined,
      resultType: 'complete',
    })
    fake.detail({ ref: HYDRA_CARD })!.answer({
      data: undefined,
      resultType: 'complete',
    })
    assert.deepEqual(
      await opened,
      { unavailable: ['nothing-here'] },
    )
    assert.ok(
      states.at(-1)?.cards['task-1'],
      'a card past the references window opens by its key',
    )
    assert.equal(
      states.at(-1)?.keys.ship,
      'task-1',
    )
    watched.close()
  },
)

test(
  'an opened card waits until its detail loads, and closing settles a waiting request',
  async () => {
    const fake = fakeZero()
    const watched = watchHydra({
      zero: fake.zero,
      hydraId: 'h',
      publish: () => {},
      failed: () => {},
    })
    const opening = watched.open({ refs: ['task:attempt'] })
    answerAll({
      fake,
      references: [],
    })
    await setImmediate()
    fake.detail({ ref: HYDRA_CARD })!.answer({
      data: undefined,
      resultType: 'complete',
    })
    await setImmediate()
    assert.equal(
      await Promise.race([
        opening,
        setImmediate('waiting'),
      ]),
      'waiting',
      'a task still being created has no row yet',
    )
    watched.close()
    assert.deepEqual(
      await opening,
      { unavailable: [] },
    )
    assert.ok(fake.views.every(view => view.destroyed))
  },
)

test(
  'an opened card fails to open, rather than waiting, while the board cannot be read',
  async () => {
    const fake = fakeZero()
    const watched = watchHydra({
      zero: fake.zero,
      hydraId: 'h',
      publish: () => {},
      failed: () => {},
    })
    const opening = watched.open({ refs: ['ship'] })
    fake.live({ name: 'board.cards' })[0]!.answer({
      data: [],
      resultType: 'error',
      message: 'query endpoint unreachable',
    })
    await assert.rejects(
      opening,
      /query endpoint unreachable/,
    )
    watched.close()
  },
)

test(
  'a view Zero failed reads again only once a retry builds it anew, and the rest keep theirs',
  async () => {
    const fake = fakeZero()
    const states: HydraState[] = []
    const watched = watchHydra({
      zero: fake.zero,
      hydraId: 'h',
      publish: ({ state }) => states.push(state),
      failed: () => {},
    })
    const failed = fake.live({ name: 'board.cards' })[0]!
    failed.answer({
      data: [],
      resultType: 'error',
      message: 'query endpoint unreachable',
    })
    answerAll({
      fake,
      references: [],
    })
    await setImmediate()
    fake.detail({ ref: HYDRA_CARD })!.answer({
      data: undefined,
      resultType: 'complete',
    })
    await setImmediate()
    assert.equal(
      states.length,
      0,
      'the failed view never answers again, so the board waits',
    )

    watched.retry()
    assert.ok(failed.destroyed)
    assert.equal(
      fake.views.filter(view => view.name === 'hydra.one').length,
      1,
      'a view that read keeps reading',
    )
    fake.live({ name: 'board.cards' })[0]!.answer({
      data: [],
      resultType: 'complete',
    })
    await setImmediate()
    assert.equal(
      states.at(-1)?.seq,
      3,
    )
    watched.close()
  },
)

test(
  'a query Zero cannot answer names its error instead of leaving the Hydra loading',
  async () => {
    const fake = fakeZero()
    const failures: string[] = []
    const watched = watchHydra({
      zero: fake.zero,
      hydraId: 'h',
      publish: () => {},
      failed: ({ message }) => failures.push(message),
    })
    fake.live({ name: 'board.cards' })[0]!.answer({
      data: [],
      resultType: 'error',
      message: 'query endpoint unreachable',
    })
    await setImmediate()
    assert.deepEqual(
      failures,
      ['query endpoint unreachable'],
    )
    watched.close()
  },
)

const boardCard = ({
  id,
  title = id,
}: {
  id: string
  title?: string
}) => ({
  ...reference({
    id,
    key: id,
  }),
  hidden: false,
  child_working: false,
  wait_title: null,
  unmet_prerequisites: [],
  body: {
    data: {
      id,
      title,
    },
  },
  replies: [],
  questions: [],
  declarations: [],
  links: [],
})

test(
  'a Hydra with no row yet shows empty and answers every opened card as missing',
  async () => {
    const fake = fakeZero()
    const states: HydraState[] = []
    const watched = watchHydra({
      zero: fake.zero,
      hydraId: 'h',
      publish: ({ state }) => states.push(state),
      failed: () => {},
    })
    const opened = watched.open({ refs: ['ship'] })
    answerAll({
      fake,
      references: [],
    })
    fake.live({ name: 'hydra.one' })[0]!.answer({
      data: undefined,
      resultType: 'complete',
    })
    await setImmediate()
    fake.detail({ ref: HYDRA_CARD })!.answer({
      data: undefined,
      resultType: 'complete',
    })
    fake.detail({ ref: 'ship' })!.answer({
      data: undefined,
      resultType: 'complete',
    })
    await setImmediate()
    assert.equal(
      states.at(-1)?.seq,
      0,
    )
    assert.deepEqual(
      states.at(-1)?.cards,
      {},
    )
    assert.deepEqual(
      await opened,
      { unavailable: ['ship'] },
    )
    watched.close()
  },
)

test(
  'an opened card whose detail fails or still loads leaves the board showing, and its request waits only for it',
  async () => {
    const fake = fakeZero()
    const states: HydraState[] = []
    const failures: string[] = []
    const watched = watchHydra({
      zero: fake.zero,
      hydraId: 'h',
      publish: ({ state }) => states.push(state),
      failed: ({ message }) => failures.push(message),
    })
    const opened = watched.open({
      refs: [
        'broken',
        'slow',
      ],
    })
    answerAll({
      fake,
      references: [
        reference({
          id: 'broken',
          key: 'broken',
        }),
        reference({
          id: 'slow',
          key: 'slow',
        }),
      ],
    })
    await setImmediate()
    fake.detail({ ref: HYDRA_CARD })!.answer({
      data: undefined,
      resultType: 'complete',
    })
    fake.detail({ ref: 'broken' })!.answer({
      data: undefined,
      resultType: 'error',
      message: 'detail query failed',
    })
    await setImmediate()
    assert.equal(
      states.at(-1)?.seq,
      3,
      'the board publishes while one detail failed and another still loads',
    )
    assert.deepEqual(
      failures.at(-1),
      'detail query failed',
    )
    assert.equal(
      await Promise.race([
        opened,
        setImmediate('waiting'),
      ]),
      'waiting',
      'the request waits for the card still loading',
    )
    fake.detail({ ref: 'slow' })!.answer({
      data: detailRow({ id: 'slow' }),
      resultType: 'complete',
    })
    assert.deepEqual(
      await opened,
      { unavailable: [] },
      'a card whose detail failed is not reported missing',
    )
    assert.ok(states.at(-1)?.cards.slow)
    watched.close()
  },
)

test(
  'a write that changes one card keeps every other card, and one that changes only the Hydra row keeps the cards and config',
  async () => {
    const fake = fakeZero()
    const published: {
      state: HydraState
      queue: unknown
    }[] = []
    const watched = watchHydra({
      zero: fake.zero,
      hydraId: 'h',
      publish: ({
        state,
        queue,
      }) => published.push({
        state,
        queue,
      }),
      failed: () => {},
    })
    const kept = boardCard({ id: 'task-kept' })
    const changed = boardCard({ id: 'task-changed' })
    const hydra = fake.live({ name: 'hydra.one' })[0]!
    const cards = fake.live({ name: 'board.cards' })[0]!
    answerAll({
      fake,
      references: [
        kept,
        changed,
      ],
    })
    hydra.answer({
      data: {
        ...hydraRow,
        config: { name: 'Eos' },
      },
      resultType: 'complete',
    })
    cards.answer({
      data: [
        kept,
        changed,
      ],
      resultType: 'complete',
    })
    await setImmediate()
    fake.detail({ ref: HYDRA_CARD })!.answer({
      data: undefined,
      resultType: 'complete',
    })
    await setImmediate()
    const first = published.at(-1)!

    hydra.answer({
      data: {
        ...hydraRow,
        seq: 4,
        config: { name: 'Eos' },
      },
      resultType: 'complete',
    })
    await setImmediate()
    const second = published.at(-1)!.state
    assert.equal(
      second.seq,
      4,
    )
    assert.equal(
      second.cards,
      first.state.cards,
    )
    assert.equal(
      second.config,
      first.state.config,
    )

    hydra.answer({
      data: {
        ...hydraRow,
        seq: 5,
        config: { name: 'Eos' },
      },
      resultType: 'complete',
    })
    cards.answer({
      data: [
        kept,
        boardCard({
          id: 'task-changed',
          title: 'Renamed',
        }),
      ],
      resultType: 'complete',
    })
    await setImmediate()
    const third = published.at(-1)!.state
    assert.equal(
      third.cards['task-changed']?.title,
      'Renamed',
    )
    assert.equal(
      third.cards['task-kept'],
      first.state.cards['task-kept'],
    )
    assert.equal(
      third.config,
      first.state.config,
    )
    watched.close()
  },
)

test(
  'the Hydra list shows Hydras by their order, then id, and its read error reaches the page until a retry reads it again',
  async () => {
    const fake = fakeZero()
    const lists: string[][] = []
    const failures: (string | undefined)[] = []
    const watched = watchInstallation({
      zero: fake.zero,
      hydras: ({ rows }) => lists.push(rows.map(row => row.id)),
      settings: () => {},
      upgrade: () => {},
      failure: ({ message }) => failures.push(message),
      connection: () => {},
    })
    const failed = fake.live({ name: 'hydras.list' })[0]!
    failed.answer({
      data: [],
      resultType: 'error',
      message: 'query endpoint unreachable',
    })
    watched.retry()
    fake.live({ name: 'hydras.list' })[0]!.answer({
      data: [
        {
          id: 'a',
          summary: {
            id: 'a',
            order: 2000,
          },
        },
        {
          id: 'default',
          summary: {
            id: 'default',
            order: 1000,
          },
        },
        {
          id: 'b',
          summary: {
            id: 'b',
            order: 1000,
          },
        },
      ],
      resultType: 'complete',
    })
    assert.deepEqual(
      failures,
      [
        'query endpoint unreachable',
        undefined,
      ],
    )
    assert.deepEqual(
      lists,
      [
        [
          'b',
          'default',
          'a',
        ],
      ],
    )
    watched.close()
  },
)

test(
  'a Zero connection that stopped reaches the page, and a retry connects it again',
  () => {
    const fake = fakeZero()
    const states: string[] = []
    const watched = watchInstallation({
      zero: fake.zero,
      hydras: () => {},
      settings: () => {},
      upgrade: () => {},
      failure: () => {},
      connection: ({ state }) => states.push(state),
    })
    fake.connect({ name: 'error' })
    assert.deepEqual(
      states,
      ['error'],
    )
    watched.retry()
    assert.equal(
      fake.connects(),
      1,
    )
    watched.close()
    fake.connect({ name: 'closed' })
    assert.deepEqual(
      states,
      ['error'],
      'a closed watch hears nothing more',
    )
  },
)

test(
  'switching cards while detail loads settles the superseded open',
  async () => {
    const fake = fakeZero()
    const watched = watchHydra({
      zero: fake.zero,
      hydraId: 'h',
      publish: () => {},
      failed: () => {},
    })
    const first = watched.open({ refs: ['first'] })
    answerAll({
      fake,
      references: [],
    })
    await setImmediate()
    fake.detail({ ref: HYDRA_CARD })!.answer({
      data: undefined,
      resultType: 'complete',
    })
    const second = watched.open({ refs: ['second'] })
    await setImmediate()
    fake.detail({ ref: 'second' })!.answer({
      data: detailRow({ id: 'second' }),
      resultType: 'complete',
    })
    assert.deepEqual(
      await first,
      { unavailable: [] },
    )
    assert.deepEqual(
      await second,
      { unavailable: [] },
    )
    watched.close()
  },
)
