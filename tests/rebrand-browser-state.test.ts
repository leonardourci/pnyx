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

test(
  'restores a saved task editor draft and keeps editing its existing browser record',
  async () => {
    const origin = 'http://example.test'
    const installation = 'saved-installation'
    const savedKey = `pnyx:view:${JSON.stringify([
      origin,
      installation,
      'task',
      'west:task-saved',
      'editor.title',
    ])}`
    const records = new Map([
      [
        savedKey,
        JSON.stringify('My saved task title'),
      ],
    ])
    vi.stubGlobal(
      'addEventListener',
      vi.fn(),
    )
    vi.stubGlobal(
      'document',
      { querySelector: () => ({ content: installation }) },
    )
    vi.stubGlobal(
      'location',
      { origin },
    )
    vi.stubGlobal(
      'sessionStorage',
      {
        getItem: records.get.bind(records),
        setItem: records.set.bind(records),
        removeItem: records.delete.bind(records),
      },
    )
    const {
      sessionView,
      sessionViewKey,
    } = await import('#web-app/session-view.ts')
    const view = sessionView({
      key: sessionViewKey({
        scope: 'task',
        id: 'west:task-saved',
        field: 'editor.title',
      }),
      initial: 'Published task title',
    })
    expect(view.snapshot()).toBe('My saved task title')
    view.set('My revised draft')
    expect(JSON.parse(records.get(savedKey)!)).toBe('My revised draft')
  },
)
