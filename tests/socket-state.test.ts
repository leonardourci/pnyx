import { beforeAll, expect, test } from 'vitest'
import { applyPageChanges, pageChanges } from '#app/socket-state.ts'
import { startPnyx, until, type Pnyx } from './setup/pnyx.ts'
import { openHomePage } from './setup/home-page.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
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
  },
)

test(
  'one socket reads Hydra state and resumes changes after a disconnect without private steering',
  async () => {
    const hydra = await pnyx.hydra()

    for (const key of [
      'changed',
      'retained',
    ]) {
      await hydra.owner({
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

    await hydra.owner({
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
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const before = page.read()
    const state = before.home.scopes[hydra.id]!.state
    const changed = state.keys.changed!
    const retained = state.keys.retained!
    expect(state.cards[changed]?.title).toBe('changed')
    expect(JSON.stringify(page.frames)).not.toContain('PRIVATE-STEERING')
    page.close()
    await hydra.owner({
      args: [
        'task',
        'rename',
        'changed',
        '--title',
        'Saved while disconnected',
      ],
    })
    const resumed = await openHomePage({
      port: pnyx.port(),
      hydraId: hydra.id,
      previous: before,
    })

    try {
      const current = resumed.read().home.scopes[hydra.id]!.state
      expect(current.cards[changed]?.title).toBe('Saved while disconnected')
      expect(current.cards[retained]).toBe(state.cards[retained])
      expect(resumed.frames.some(frame => frame.type === 'home.snapshot')).toBe(false)
      expect(resumed.read().cursor.seq).toBeGreaterThan(before.cursor.seq)
      await hydra.owner({
        args: [
          'task',
          'rename',
          'changed',
          '--title',
          'Live change',
        ],
      })
      await until({
        what: 'the same socket to carry the next saved change',
        check: () => resumed.read().home.scopes[hydra.id]?.state.cards[changed]?.title === 'Live change',
      })
      expect(JSON.stringify(resumed.frames)).not.toContain('PRIVATE-STEERING')
    } finally {
      resumed.close()
    }
  },
)

test(
  'a cursor from another daemon falls back to a snapshot and the Hydra list excludes removed Hydras',
  async () => {
    const caller = await pnyx.hydra()
    const target = await pnyx.hydra()
    const initial = await openHomePage({
      port: pnyx.port(),
      hydraId: caller.id,
    })
    const previous = initial.read()
    initial.close()
    await caller.owner({
      args: [
        'hydra',
        'remove',
        target.id,
      ],
    })
    const page = await openHomePage({
      port: pnyx.port(),
      hydraId: caller.id,
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
      expect(page.read().home.hydras).toContainEqual(expect.objectContaining({ id: caller.id }))
      expect(page.read().home.hydras).not.toContainEqual(expect.objectContaining({ id: target.id }))
    } finally {
      page.close()
    }
  },
)

test(
  'socket object changes preserve literal prototype-named keys',
  () => {
    const before = { values: {} }
    const after = JSON.parse('{"values":{"__proto__":{"title":"Owner value"},"constructor":{"title":"Another value"}}}')
    const changes = pageChanges({
      before,
      after,
    })!
    const next = applyPageChanges({
      before,
      changes,
    })
    expect(next).toEqual(after)
    expect(Object.hasOwn(
      next.values,
      '__proto__',
    )).toBe(true)
    expect(Object.getPrototypeOf(next.values)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(before.values)).toBe(Object.prototype)
  },
)

test(
  'the home socket never exposes the database URL in snapshots or changes',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHomePage({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const before = page.read().home.settings.revision
      await hydra.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({postgresUrl: 'postgres://owner:PRIVATE-DATABASE-PASSWORD@localhost/private-database'}),
        ],
      })
      await until({
        what: 'the settings revision on the home socket',
        check: () => page.read().home.settings.revision > before,
      })
      expect(page.read().home.settings.settings).not.toHaveProperty('postgresUrl')
      expect(JSON.stringify(page.frames)).not.toContain('PRIVATE-DATABASE-PASSWORD')
      const snapshot = await openHomePage({
        port: pnyx.port(),
        hydraId: hydra.id,
      })

      try {
        expect(snapshot.read().home.settings.settings).not.toHaveProperty('postgresUrl')
        expect(JSON.stringify(snapshot.frames)).not.toContain('PRIVATE-DATABASE-PASSWORD')
      } finally {
        snapshot.close()
      }
    } finally {
      await hydra.owner({
        args: [
          'settings',
          'set',
          '--json',
          '{"postgresUrl":""}',
        ],
      })
      page.close()
    }
  },
)
