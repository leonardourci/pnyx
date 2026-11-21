import { expect, test, vi } from 'vitest'
import { createSocketHistory } from '#app/socket-history.ts'

test(
  'retention evicts by bytes and an omitted large change still advances the cursor',
  () => {
    const history = createSocketHistory<string>({
      epoch: 'bounded',
      byteLimit: 6,
      measure: ({ frame }) => frame.value.length,
    })
    const initial = history.cursor()
    const first = history.append({ value: 'one' })
    const second = history.append({ value: 'two' })
    history.append({ value: 'six' })
    expect(history.since({ cursor: initial })).toBeUndefined()
    expect(history.since({ cursor: first })?.map(frame => frame.value)).toEqual([
      'two',
      'six',
    ])
    const omitted = history.append({ value: 'too large' })
    expect(omitted.seq).toBe(second.seq + 2)
    expect(history.since({ cursor: second })).toBeUndefined()
    expect(history.since({ cursor: omitted })).toEqual([])
    history.append({ value: 'new' })
    expect(history.since({ cursor: omitted })?.map(frame => frame.value)).toEqual(['new'])
  },
)

test(
  'an over-budget replay is refused before cloning any retained frames',
  () => {
    const measure = vi.fn(() => 3)
    const history = createSocketHistory<string>({
      epoch: 'preflight',
      measure,
    })
    const initial = history.cursor()
    history.append({ value: 'one' })
    history.append({ value: 'two' })
    const clone = vi.spyOn(
      globalThis,
      'structuredClone',
    )

    try {
      expect(history.since({
        cursor: initial,
        budget: 5,
      })).toBeUndefined()
      expect(clone).not.toHaveBeenCalled()
      expect(measure).toHaveBeenCalledTimes(2)
      expect(history.since({
        cursor: initial,
        budget: 6,
      })?.map(frame => frame.value)).toEqual([
        'one',
        'two',
      ])
    } finally {
      clone.mockRestore()
    }
  },
)

test(
  'a reconnect resumes every retained home change once in order',
  () => {
    const history = createSocketHistory<{ task: string }>({
      limit: 3,
      epoch: 'daemon-one',
    })
    const initial = history.cursor()
    const first = history.append({ value: { task: 'first' } })
    history.append({ value: { task: 'second' } })
    history.append({ value: { task: 'third' } })
    expect(history.since({ cursor: initial })?.map(frame => frame.value.task))
      .toEqual([
        'first',
        'second',
        'third',
      ])
    expect(history.since({ cursor: first })?.map(frame => frame.seq)).toEqual([
      2,
      3,
    ])
    expect(history.since({ cursor: history.cursor() })).toEqual([])
    history.append({ value: { task: 'fourth' } })
    expect(history.since({ cursor: initial })).toBeUndefined()
    expect(history.since({ cursor: first })?.map(frame => frame.value.task))
      .toEqual([
        'second',
        'third',
        'fourth',
      ])
  },
)

test(
  'a different daemon or invalid cursor requires a fresh home snapshot',
  () => {
    const history = createSocketHistory({ epoch: 'daemon-two' })
    history.append({ value: 'saved' })

    for (const cursor of [
      {
        epoch: 'daemon-one',
        seq: 1,
      },
      {
        epoch: 'daemon-two',
        seq: -1,
      },
      {
        epoch: 'daemon-two',
        seq: 2,
      },
      {
        epoch: 'daemon-two',
        seq: 0.5,
      },
    ]) {
      expect(history.since({ cursor })).toBeUndefined()
    }

    expect(history.since({})).toBeUndefined()
  },
)

test(
  'published values and replay replies cannot change retained home history',
  () => {
    const history = createSocketHistory<{ title: string }>({ epoch: 'daemon' })
    const value = { title: 'Saved owner words' }
    const initial = history.cursor()
    expect(() => history.append({
      value: {
        get title(): string {
          throw new Error('Cannot read the change')
        },
      },
    })).toThrow('Cannot read the change')
    const published = history.append({ value })
    expect(published.seq).toBe(initial.seq + 1)
    value.title = 'Changed after publication'
    published.value.title = 'Changed by sender'
    const replay = history.since({ cursor: initial })!
    expect(replay[0]?.value.title).toBe('Saved owner words')
    replay[0]!.value.title = 'Changed by receiver'
    expect(history.since({ cursor: initial })?.[0]?.value.title).toBe('Saved owner words')
  },
)
