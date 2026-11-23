import { afterEach, expect, test, vi } from 'vitest'
import { readAttempt, saveAttempt } from '#web-titan/outbox.ts'

afterEach(() => vi.unstubAllGlobals())

test(
  'reopens an existing pending send without allocating a new receipt identity',
  () => {
    const attempt = {
      text: 'My unsent draft',
      id: 'saved-attempt',
      pending: true,
    }
    const records = new Map([
      [
        'pnyx:west:send:chat',
        JSON.stringify(attempt),
      ],
    ])
    vi.stubGlobal(
      'sessionStorage',
      {
        getItem: records.get.bind(records),
        setItem: records.set.bind(records),
        removeItem: records.delete.bind(records),
      },
    )
    expect(readAttempt({
      hydraId: 'west',
      key: 'chat',
    })).toEqual(attempt)
    saveAttempt({
      hydraId: 'west',
      key: 'chat',
      attempt: {
        ...attempt,
        pending: false,
      },
    })
    expect(JSON.parse(records.get('pnyx:west:send:chat')!)).toEqual({
      ...attempt,
      pending: false,
    })
    expect(records.has('othrys:west:send:chat')).toBe(false)
  },
)
