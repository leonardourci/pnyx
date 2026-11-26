import { beforeAll, expect, test } from 'vitest'
import { applyPageChanges, pageChanges } from '#app/socket-state.ts'
import { startOthrys, until, type Othrys } from './setup/othrys.ts'
import { openHomePage } from './setup/home-page.ts'

const REPLAY_BRIEF_LENGTH = 23_997
const REPLAY_EDIT_COUNT = 50

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

test(
  'socket patches retain unchanged cards and distinguish a cleared value from a removed field',
  () => {
    const retained = { title: 'Keep this card mounted' }
    const before = {
      cards: {
        retained,
        changed: {
          title: 'Before',
          hold: 'Waiting',
        },
      },
      option: 'old',
    }
    const after = {
      cards: {
        retained,
        changed: {
          title: 'After',
          hold: null,
        },
      },
    }
    const changes = pageChanges({
      before,
      after,
    })!
    const next = applyPageChanges({
      before,
      changes,
    })
    expect(next).toEqual(after)
    expect(next.cards.retained).toBe(retained)
    expect(next.cards.changed).not.toBe(before.cards.changed)
    expect(before.cards.changed.title).toBe('Before')

    const prototypeBefore = { values: {} }
    const prototypeAfter = JSON.parse('{"values":{"__proto__":{"title":"Owner value"},"constructor":{"title":"Another value"}}}')
    const prototypeChanges = pageChanges({
      before: prototypeBefore,
      after: prototypeAfter,
    })!
    const prototypeNext = applyPageChanges({
      before: prototypeBefore,
      changes: prototypeChanges,
    })
    expect(prototypeNext).toEqual(prototypeAfter)
    expect(Object.hasOwn(
      prototypeNext.values,
      '__proto__',
    )).toBe(true)
    expect(Object.getPrototypeOf(prototypeNext.values)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(prototypeBefore.values)).toBe(Object.prototype)
  },
)

test(
  'one socket reads Titan state and resumes changes after a disconnect without private steering',
  async () => {
    const titan = await othrys.titan()

    for (const key of [
      'changed',
      'retained',
    ]) {
      await titan.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--title',
          key,
          '--key',
          key,
        ],
      })
    }

    await titan.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'changed',
        'private-1',
        '--text',
        'PRIVATE-STEERING',
      ],
    })
    const page = await openHomePage({
      port: othrys.port(),
      titanId: titan.id,
    })
    const before = page.read()
    const state = before.home.scopes[titan.id]!.state
    const changed = state.keys.changed!
    const retained = state.keys.retained!
    expect(state.cards[changed]?.title).toBe('changed')
    expect(JSON.stringify(page.frames)).not.toContain('PRIVATE-STEERING')
    page.close()
    await titan.owner({
      args: [
        'task',
        'inbox',
        'enqueue',
        'changed',
        'private-2',
        '--text',
        'PRIVATE-REPLAY-STEERING',
      ],
    })
    await titan.owner({
      args: [
        'task',
        'rename',
        'changed',
        '--title',
        'Saved while disconnected',
      ],
    })
    const resumed = await openHomePage({
      port: othrys.port(),
      titanId: titan.id,
      previous: before,
    })

    try {
      const current = resumed.read().home.scopes[titan.id]!.state
      expect(current.cards[changed]?.title).toBe('Saved while disconnected')
      expect(current.cards[retained]).toBe(state.cards[retained])
      expect(resumed.frames.some(frame => frame.type === 'home.snapshot')).toBe(false)
      expect(resumed.read().cursor.seq).toBeGreaterThan(before.cursor.seq)
      const receipt = await resumed.send({
        name: 'task',
        args: [
          'rename',
          'changed',
          '--title',
          'Live change',
        ],
      })
      expect(receipt.type).toBe('receipt')
      await until({
        what: 'the same socket to carry the next saved change',
        check: () => resumed.read().home.scopes[titan.id]?.state.cards[changed]?.title === 'Live change',
      })
      expect(JSON.stringify(resumed.frames)).not.toContain('PRIVATE-STEERING')
      expect(JSON.stringify(resumed.frames)).not.toContain('PRIVATE-REPLAY-STEERING')
    } finally {
      resumed.close()
    }
  },
)

test(
  'a cursor from another daemon falls back to a snapshot and the Titan list excludes removed Titans',
  async () => {
    const caller = await othrys.titan()
    const target = await othrys.titan()
    const initial = await openHomePage({
      port: othrys.port(),
      titanId: caller.id,
    })
    const previous = initial.read()
    initial.close()
    await caller.owner({
      args: [
        'titan',
        'remove',
        target.id,
      ],
    })
    const page = await openHomePage({
      port: othrys.port(),
      titanId: caller.id,
      previous: {
        ...previous,
        cursor: {
          ...previous.cursor,
          epoch: 'other-daemon',
        },
      },
    })

    try {
      expect(page.frames[0]?.type).toBe('home.snapshot')
      expect(page.read().home.titans).toContainEqual(expect.objectContaining({ id: caller.id }))
      expect(page.read().home.titans).not.toContainEqual(expect.objectContaining({ id: target.id }))
    } finally {
      page.close()
    }
  },
)

test(
  'the removed database setting is refused without publishing a home change',
  async () => {
    const titan = await othrys.titan()
    const page = await openHomePage({
      port: othrys.port(),
      titanId: titan.id,
    })

    try {
      const before = page.read().home.settings.revision
      const rejected = await titan.ownerRefused({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({postgresUrl: 'postgres://owner:PRIVATE-DATABASE-PASSWORD@localhost/private-database'}),
        ],
      })
      expect(rejected.code).toBe('VALIDATION_ERROR')
      expect(page.read().home.settings.revision).toBe(before)
      expect(page.read().home.settings.settings).not.toHaveProperty('postgresUrl')
      expect(JSON.stringify(page.frames)).not.toContain('PRIVATE-DATABASE-PASSWORD')
      const snapshot = await openHomePage({
        port: othrys.port(),
        titanId: titan.id,
      })

      try {
        expect(snapshot.read().home.settings.settings).not.toHaveProperty('postgresUrl')
        expect(JSON.stringify(snapshot.frames)).not.toContain('PRIVATE-DATABASE-PASSWORD')
      } finally {
        snapshot.close()
      }
    } finally {
      page.close()
    }
  },
)

test(
  'a reconnect with more retained changes than its outgoing budget receives the latest snapshot',
  async () => {
    const titan = await othrys.titan()
    const created = await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Large replay',
        '--key',
        'large-replay',
      ],
    })
    const task = created.card.id
    const initial = await openHomePage({
      port: othrys.port(),
      titanId: titan.id,
    })
    const previous = initial.read()
    initial.close()
    const padding = 'x'.repeat(REPLAY_BRIEF_LENGTH)

    for (let revision = 0; revision < REPLAY_EDIT_COUNT; revision += 1) {
      const brief = `${String(revision).padStart(
        2,
        '0',
      )} ${padding}`
      await titan.owner({
        args: [
          'task',
          'brief',
          'large-replay',
          '--brief',
          brief,
        ],
      })
      await until({
        what: 'the changed brief to reach the home feed',
        check: () => othrys.home().scopes[titan.id]?.state.cards[task]?.brief === brief,
      })
    }

    const resumed = await openHomePage({
      port: othrys.port(),
      titanId: titan.id,
      previous,
    })

    try {
      expect(resumed.frames[0]?.type).toBe('home.snapshot')
      expect(resumed.read().home.scopes[titan.id]?.state.cards[task]?.brief).toBe(`49 ${padding}`)
      expect(resumed.read().cursor.epoch).toBe(previous.cursor.epoch)
      expect(resumed.read().cursor.seq).toBeGreaterThan(previous.cursor.seq)
    } finally {
      resumed.close()
    }
  },
)
