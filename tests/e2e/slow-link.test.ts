import { beforeAll, test } from 'vitest'
import { MAX_BRIEF_LENGTH } from '#tasks/model.ts'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, type Pnyx } from '../setup/pnyx.ts'

// Tasks with the longest brief, whose first sync reaches the page as two 1 MiB chunks.
const LARGE_SYNC_TASKS = 40
const LARGE_BRIEF = 'x'.repeat(MAX_BRIEF_LENGTH)
// Chrome throttles WebSocket data to about a quarter of this rate: 13 to 15 s per chunk, longer than two default 5 s
// ping waits and shorter than two of the page's 10 s ones.
const SLOW_LINK = {
  urlPattern: '',
  latency: 150,
  downloadThroughput: 320_000,
  uploadThroughput: 320_000,
}
const SLOW_SYNC_MS = 90_000

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'a Hydra with a large first sync loads over a slow link',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'apply',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        version: 1,
        changes: Array.from(
          { length: LARGE_SYNC_TASKS },
          (
            _,
            index,
          ) => ({
            op: 'task.create',
            title: `Large task ${index + 1}`,
            brief: LARGE_BRIEF,
          }),
        ),
      }),
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: async ({ page }) => {
        const devtools = await page.context().newCDPSession(page)
        await devtools.send('Network.enable')
        await devtools.send(
          'Network.emulateNetworkConditionsByRule',
          { matchedNetworkConditions: [SLOW_LINK] },
        )
      },
    })

    await page.getByRole(
      'button',
      {
        name: 'Large task 1',
        exact: true,
      },
    ).waitFor({ timeout: SLOW_SYNC_MS })
  },
)
