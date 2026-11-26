import { beforeAll, expect, test } from 'vitest'
import { loadTitan } from '#app/store.ts'
import { startOthrys, type Othrys } from './setup/othrys.ts'

let app: Othrys
beforeAll(async () => {
  app = await startOthrys()
})

test(
  'Titan commands keep worker task targeting and notices',
  async () => {
    const caller = await app.titan()
    const { worker } = await caller.startTask({ key: 'alias-worker' })
    const mine = await caller.task({ key: 'alias-worker' })
    const asWorker = caller.as({ session: worker })
    const sent = await asWorker.run({
      args: [
        'titan',
        'send',
        '--task',
        mine.id,
        '--text',
        'Forward this update',
        '--action',
        'send',
      ],
    })
    expect(sent.notices ?? []).not.toContainEqual(expect.objectContaining({ reason: expect.stringContaining('outside the worker') }))
    expect(sent.notices ?? []).not.toContainEqual(expect.objectContaining({ reason: expect.stringContaining('changed another task') }))
    const target = await app.titan()
    const removed = await asWorker.run({
      args: [
        'titan',
        'remove',
        target.id,
      ],
    })
    expect(removed.removed).toBe(target.id)
    expect(removed.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('outside the worker') }))
    expect(loadTitan({ titanId: target.id }).state.config?.removed).toBe(true)
  },
)

test(
  'a scoped page refuses a foreign Titan flag and still removes a Titan',
  async () => {
    const caller = await app.titan()
    const target = await app.titan()
    const page = await caller.page()

    try {
      const refused = await page.send({
        name: 'titan',
        args: [
          'show',
          '--titan',
          target.id,
        ],
      })
      expect(refused).toMatchObject({
        type: 'error',
        code: 'VALIDATION_ERROR',
      })

      const removed = await page.send({
        name: 'titan',
        args: [
          'remove',
          target.id,
        ],
      })
      expect(removed).toMatchObject({
        type: 'receipt',
        removed: target.id,
      })
      expect(loadTitan({ titanId: target.id }).state.config?.removed).toBe(true)
    } finally {
      page.close()
    }
  },
)
