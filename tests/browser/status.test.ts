import { beforeAll, expect, test } from 'vitest'
import { chrome } from './chrome.ts'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { zeroReady } from '../setup/zero.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'an idle worker has the same status on its pill, chat and CLI without a declaration',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.startTask({ key: 'status-facts' })
    await until({
      what: 'the worker turn to end',
      check: async () => (await hydra.task({ key: 'status-facts' })).status === 'idle',
    })
    const task = await hydra.task({ key: 'status-facts' })
    await zeroReady({
      url: `http://127.0.0.1:${pnyx.port()}/zero/`,
      cookie: `${zeroCookieName({ port: pnyx.port() })}=${localToken()}`,
    })
    const selector = `[data-task="${task.id}"]`

    const status = async ({ label }: { label: string }) => {
      const result = await chrome({
        script: `
        await page.wait(${JSON.stringify(`${selector} .agent-activity[aria-label="${label}"]`)}, 5000);
        console.log(await page.eval(() => document.querySelector(${JSON.stringify(`${selector} [aria-label="Worker status"]`)})?.textContent));
      `,
      })
      expect(result).toBe(label)
    }

    await chrome({
      script: `
      await page.open(${JSON.stringify(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/`)});
      await page.wait(${JSON.stringify(`${selector} .card-open`)}, 5000);
      await page.click(${JSON.stringify(`${selector} .card-open`)});
      await page.wait(${JSON.stringify(`${selector} [aria-label="Worker status"]`)}, 5000);
    `,
    })
    await status({ label: 'Idle' })
    expect((await hydra.task({ key: 'status-facts' })).status).toBe('idle')
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Run another turn'),
      reply: 'Turn complete',
      hold: true,
    })
    await hydra.owner({
      args: [
        'reply',
        'status-facts',
        '--text',
        'Run another turn',
      ],
    })
    await until({
      what: 'CLI running status',
      check: async () => (await hydra.task({ key: 'status-facts' })).status === 'running',
    })
    await status({ label: 'Running' })
    turn.release()
    await until({
      what: 'CLI idle status after another turn',
      check: async () => (await hydra.task({ key: 'status-facts' })).status === 'idle',
    })
    await status({ label: 'Idle' })
  },
)
