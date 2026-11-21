import { expect, test } from 'vitest'
import { createSocketHistory } from '#app/socket-history.ts'

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
        get title() {
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
