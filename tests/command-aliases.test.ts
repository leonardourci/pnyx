import { beforeAll, expect, test } from 'vitest'
import { parseCommandArgs } from '#app/command-aliases.ts'
import { loadTitan } from '#app/store.ts'
import { startOthrys, othrys, parsed, type Othrys } from './setup/othrys.ts'

let app: Othrys
beforeAll(async () => {
  app = await startOthrys()
})

test(
  'public Titan flags preserve flag-like user content and positional data',
  () => {
    const result = parseCommandArgs({
      args: [
        '--text=--titan',
        '--titan=west',
        '--',
        '--titan',
      ],
      options: {
        hydra: { type: 'string' },
        text: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    expect(result.values).toEqual({
      hydra: 'west',
      text: '--titan',
    })
    expect(result.positionals).toEqual(['--titan'])
  },
)

test(
  'public Titan commands and flags retain worker task targeting and notices',
  async () => {
    const caller = await app.hydra()
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
    const target = await app.hydra()
    const removed = await asWorker.run({
      args: [
        'titan',
        'remove',
        target.id,
      ],
    })
    expect(removed.removed).toBe(target.id)
    expect(removed.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('outside the worker') }))
    expect(loadTitan({ hydraId: target.id }).state.config?.removed).toBe(true)
  },
)

test(
  'a scoped page accepts the Titan alias and refuses either spelling of a foreign Titan flag',
  async () => {
    const caller = await app.hydra()
    const target = await app.hydra()
    const page = await caller.page()

    try {
      for (const flag of [
        '--titan',
        '--hydra',
      ]) {
        const refused = await page.send({
          name: 'titan',
          args: [
            'show',
            flag,
            target.id,
          ],
        })
        expect(refused).toMatchObject({
          type: 'error',
          code: 'VALIDATION_ERROR',
        })
      }

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
      expect(loadTitan({ hydraId: target.id }).state.config?.removed).toBe(true)
    } finally {
      page.close()
    }
  },
)

test(
  'a resumed worker using legacy environment names retains its identity on the real CLI',
  async () => {
    const caller = await app.hydra()
    const { worker } = await caller.startTask({ key: 'legacy-worker' })
    const mine = await caller.task({ key: 'legacy-worker' })
    await caller.startTask({ key: 'foreign' })
    const foreign = await caller.task({ key: 'foreign' })
    const env = { ...worker.env }

    for (const [
      key,
      value,
    ] of Object.entries(env)) {
      if (key.startsWith('OTHRYS_')) {
        const legacy = key.replace(
          'OTHRYS_',
          'PNYX_',
        ).replace(
          'TITAN',
          'HYDRA',
        )
        env[legacy] = value
        delete env[key]
      }
    }

    const result = await othrys({
      args: [
        'send',
        '--task',
        foreign.id,
        '--text',
        'Legacy worker update',
        '--hydra',
        caller.id,
        '--json',
      ],
      env,
    })
    expect(
      result.status,
      `${result.stdout}${result.stderr}`,
    ).toBe(0)
    const receipt = parsed(result)
    expect(receipt.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('outside the worker') }))
    const history = await caller.owner({
      args: [
        'task',
        'history',
        foreign.id,
      ],
    })
    expect(history.events).toContainEqual(expect.objectContaining({ actor: `worker:${mine.id}` }))
  },
)
