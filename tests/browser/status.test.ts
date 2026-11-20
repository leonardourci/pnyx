import { beforeAll, expect, test } from 'vitest'
import { chrome } from './chrome.ts'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { zeroReady } from '../setup/zero.ts'
import { workerLine } from '../setup/worker-log.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

async function openChat({
  hydraId,
  taskId,
}: {
  hydraId: string
  taskId: string
}) {
  await zeroReady({
    url: `http://127.0.0.1:${pnyx.port()}/zero/`,
    cookie: `${zeroCookieName({ port: pnyx.port() })}=${localToken()}`,
  })
  const selector = `[data-task="${taskId}"]`
  await chrome({
    script: `
    await page.open(${JSON.stringify(`http://127.0.0.1:${pnyx.port()}/hydra/${hydraId}/`)});
    await page.wait(${JSON.stringify(`${selector} .card-open`)}, 5000);
    await page.click(${JSON.stringify(`${selector} .card-open`)});
    await page.wait(${JSON.stringify(`${selector} [aria-label="Worker status"]`)}, 5000);
  `,
  })

  return selector
}

async function status({
  selector,
  label,
}: {
  selector: string
  label: string
}) {
  const result = await chrome({
    script: `
    await page.wait(${JSON.stringify(`${selector} .agent-activity[aria-label="${label}"]`)}, 5000);
    const chat = ${JSON.stringify(`${selector} [aria-label="Worker status"][data-status="${label}"]`)};
    await page.wait(chat, 5000);
    console.log(await page.eval(() => document.querySelector(${JSON.stringify(`${selector} [aria-label="Worker status"]`)})?.textContent));
  `,
  })
  expect(result).toBe(label)
}

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
    const selector = await openChat({
      hydraId: hydra.id,
      taskId: task.id,
    })
    await status({
      selector,
      label: 'Idle',
    })
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
    await status({
      selector,
      label: 'Running',
    })
    turn.release()
    await until({
      what: 'CLI idle status after another turn',
      check: async () => (await hydra.task({ key: 'status-facts' })).status === 'idle',
    })
    await status({
      selector,
      label: 'Idle',
    })
  },
)

test(
  'Oracle preserves worker status when a task has a retention deadline',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.startTask({ key: 'blocked-in-done' })
    await until({
      what: 'the worker turn to end',
      check: async () => (await hydra.task({ key: 'blocked-in-done' })).status === 'idle',
    })
    await workerLine({
      hydra,
      key: 'blocked-in-done',
      line: 'blocked: Waiting for a missing fixture',
    })
    const task = await hydra.task({ key: 'blocked-in-done' })
    const done = await hydra.column({ role: 'done' })
    await hydra.owner({
      args: [
        'outcome',
        task.id,
        'done',
        '--note',
        'Owner closed the work',
      ],
    })
    expect(await hydra.task({ key: 'blocked-in-done' })).toMatchObject({
      status: 'blocked',
      column: done,
    })
    const selector = await openChat({
      hydraId: hydra.id,
      taskId: task.id,
    })
    await status({
      selector,
      label: 'Blocked',
    })
    const preview = await chrome({
      script: `
      await page.click('.oracle-trigger');
      await page.wait('dialog[aria-label="Oracle"] input', 5000);
      await page.fill('dialog[aria-label="Oracle"] input', 'blocked-in-done');
      await page.wait('.oracle-card .agent-activity', 5000);
      console.log(await page.eval(() => document.querySelector('.oracle-card .agent-activity')?.getAttribute('aria-label')));
    `,
    })
    expect(preview).toBe('Blocked')
  },
)
