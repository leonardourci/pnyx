import { beforeAll, expect, test } from 'vitest'
import { chrome } from './chrome.ts'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { zeroReady } from '../setup/zero.ts'
import { workerLine } from '../setup/worker-log.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx
const EXITED_PROCESS_PID = '2147483647'
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

async function recordBadges({ selector }: { selector: string }) {
  await chrome({
    script: `
    await page.eval(() => {
      window.badgeFrames = [];
      window.sendFrames = {};
      window.heldSends = [];
      window.sendSocketMessage = WebSocket.prototype.send;
      WebSocket.prototype.send = function(message) {
        const command = JSON.parse(message);
        if (command.type === 'command' && command.args?.[0] === 'send' && (command.name === 'hydra' || command.name === 'task')) {
          window.heldSends.push({ socket: this, message });
        } else {
          window.sendSocketMessage.call(this, message);
        }
      };
      const readBadges = () => ({
        hydra: document.querySelector('.hydra-chat [aria-label="Hydra status"]')?.textContent,
        pill: document.querySelector(${JSON.stringify(`${selector} .activity-text`)})?.textContent,
        task: document.querySelector(${JSON.stringify(`${selector} [aria-label="Worker status"]`)})?.textContent,
      });
      document.addEventListener('click', event => {
        const button = event.target.closest?.('button');
        const send = button?.matches('[aria-label="Send reply"], [aria-label="Send to worker"]');
        if (!send) return;
        const target = button.closest('.hydra-chat') ? 'hydra' : 'worker';
        window.sendFrames[target] = window.badgeFrames.length;
        window.firstSentFrame = new Promise(resolve => requestAnimationFrame(() => resolve(readBadges())));
      }, true);
      const sample = () => {
        window.badgeFrames.push(readBadges());
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  `,
  })
}

test(
  'live badges show thinking at turn start, working through tools and idle at turn end in Focus mode',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.startTask({ key: 'live-badges' })
    await until({
      what: 'the initial worker turn to end',
      check: async () => (await hydra.task({ key: 'live-badges' })).status === 'idle',
    })
    const task = await hydra.task({ key: 'live-badges' })
    const selector = await openChat({
      hydraId: hydra.id,
      taskId: task.id,
    })
    await recordBadges({ selector })

    for (const {
      text,
      label,
      tool,
    } of [
        {
          text: 'Check live badges before tools',
          label: 'Thinking',
          tool: undefined,
        },
        {
          text: 'Check live badges with tools',
          label: 'Working',
          tool: {
            id: 'live_badge_tool',
            name: 'Bash',
            input: { command: 'pwd' },
          },
        },
      ]) {
      const hydraTurn = pnyx.claude.plan({
        hydra: hydra.id,
        text,
        tool,
        hold: true,
      })
      const workerTurn = pnyx.claude.plan({
        hydra: hydra.id,
        match: ({ text: prompt }) => prompt.includes(`Worker: ${text}`),
        tool,
        hold: true,
      })

      try {
        const started = await chrome({
          script: `
          await page.eval(() => { window.badgeFrames = []; });
          await page.fill('[aria-label="Reply to Hydra"]', ${JSON.stringify(text)});
          await page.click('.hydra-chat [aria-label="Send reply"]');
          console.log(JSON.stringify(await page.eval(() => window.firstSentFrame)));
        `,
        })
        expect(JSON.parse(started).hydra).toBe('Starting…')
        const workerStarted = await chrome({
          script: `
          await page.fill('[aria-label="Message worker"]', ${JSON.stringify(`Worker: ${text}`)});
          await page.click('[aria-label="Send to worker"]');
          console.log(JSON.stringify(await page.eval(() => window.firstSentFrame)));
          await page.eval(() => {
            for (const {socket, message} of window.heldSends.splice(0)) window.sendSocketMessage.call(socket, message);
          });
          `,
        })
        expect(JSON.parse(workerStarted)).toMatchObject({
          pill: 'Starting…',
          task: 'Starting…',
        })
        await status({
          selector,
          label,
        })
        const sampled = await chrome({
          script: `
          await page.wait('.hydra-chat [aria-label="Hydra status"][data-status="${label}"]', 5000);
          await page.eval(() => new Promise(requestAnimationFrame));
          console.log(JSON.stringify(await page.eval(() => {
            const frames = window.badgeFrames;
            const active = ['Starting…', 'Thinking', 'Working'];
            return {
              frames: frames.filter(frame => frame.hydra === ${JSON.stringify(label)} && frame.pill === ${JSON.stringify(label)} && frame.task === ${JSON.stringify(label)}).length,
              interrupted: {
                hydra: frames.slice(window.sendFrames.hydra).filter(frame => !active.includes(frame.hydra)),
                pill: frames.slice(window.sendFrames.worker).filter(frame => !active.includes(frame.pill)),
                task: frames.slice(window.sendFrames.worker).filter(frame => !active.includes(frame.task)),
              },
              tools: document.querySelectorAll('.action-bubble').length,
            };
          })));
        `,
        })
        const sample = JSON.parse(sampled)
        expect(sample.tools).toBe(0)
        expect(sample.frames).toBeGreaterThan(0)
        expect(sample.interrupted).toEqual({
          hydra: [],
          pill: [],
          task: [],
        })
      } finally {
        hydraTurn.release()
        workerTurn.release()
      }

      await status({
        selector,
        label: 'Idle',
      })
      const dots = await chrome({
        script: `
        await page.wait('.hydra-chat [aria-label="Hydra status"][data-status="Idle"]', 5000);
        console.log(await page.eval(() => document.querySelectorAll('.chat-running-status .working-dots').length));
      `,
      })
      expect(dots).toBe('0')
      expect((await hydra.task({ key: 'live-badges' })).status).toBe('idle')
    }
  },
)

test(
  'a refused turn replaces the pending Hydra and worker badges with its error',
  async () => {
    const hydra = await pnyx.hydra()
    const owner = await hydra.page()
    await owner.send({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    owner.close()
    await hydra.startTask({
      key: 'refused-badges',
      harness: 'codex',
    })
    await until({
      what: 'the initial worker turn to end',
      check: async () => (await hydra.task({ key: 'refused-badges' })).status === 'idle',
    })
    const task = await hydra.task({ key: 'refused-badges' })
    const selector = await openChat({
      hydraId: hydra.id,
      taskId: task.id,
    })
    pnyx.codex.plan({
      hydra: hydra.id,
      text: 'Refuse Hydra badge turn',
      refuse: true,
    })
    pnyx.codex.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Refuse worker badge turn'),
      refuse: true,
    })
    const result = await chrome({
      script: `
      await page.fill('[aria-label="Reply to Hydra"]', 'Refuse Hydra badge turn');
      await page.click('.hydra-chat [aria-label="Send reply"]');
      await page.fill('[aria-label="Message worker"]', 'Refuse worker badge turn');
      await page.click('[aria-label="Send to worker"]');
      await page.wait('.hydra-chat [aria-label="Hydra status"][data-status*="refused this turn"]', 5000);
      await page.wait(${JSON.stringify(`${selector} .agent-activity[aria-label*="refused this turn"]`)}, 5000);
      await page.wait(${JSON.stringify(`${selector} [aria-label="Worker status"][data-status*="refused this turn"]`)}, 5000);
      console.log(await page.eval(() => document.querySelectorAll('.chat-running-status .working-dots').length));
    `,
    })
    expect(result).toBe('0')

    const resumed = pnyx.codex.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Resume worker from CLI'),
      hold: true,
    })

    try {
      await hydra.owner({
        args: [
          'reply',
          'refused-badges',
          '--text',
          'Resume worker from CLI',
        ],
      })
      await status({
        selector,
        label: 'Thinking',
      })
    } finally {
      resumed.release()
    }

    await status({
      selector,
      label: 'Idle',
    })
    const recovery = pnyx.codex.plan({
      hydra: hydra.id,
      text: 'Recover Hydra badge turn',
      hold: true,
    })

    try {
      await chrome({
        script: `
        await page.fill('[aria-label="Reply to Hydra"]', 'Recover Hydra badge turn');
        await page.click('.hydra-chat [aria-label="Send reply"]');
        await page.wait('.hydra-chat [data-status="Thinking"]', 5000);
      `,
      })
    } finally {
      recovery.release()
    }

    await chrome({ script: 'await page.wait(\'.hydra-chat [data-status="Idle"]\', 5000);' })
  },
)

test(
  'an exited outside worker shows its delivery error on the pill and chat',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'outside-refusal',
        '--title',
        'Exited outside session',
      ],
    })
    await hydra.owner({
      args: [
        'push',
        '--key',
        'outside-session',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Exited outside session',
        activity: 'finished',
        agent: {
          provider: 'claude-code',
          sessionId: 'exited-outside-session',
        },
        // The impossible PID fails the identity check before any terminal adapter runs.
        terminal: {
          tty: '/dev/ttys9999',
          pid: EXITED_PROCESS_PID,
          program: 'Apple_Terminal',
        },
      }),
    })
    await hydra.owner({
      args: [
        'task',
        'attach',
        'outside-refusal',
        '--session',
        'claude-code:exited-outside-session',
      ],
    })
    const outside = await hydra.task({ key: 'outside-refusal' })
    const outsideSelector = await openChat({
      hydraId: hydra.id,
      taskId: outside.id,
    })
    const outsideFailure = await chrome({
      script: `
      await page.fill('[aria-label="Message worker"]', 'Try the outside route');
      await page.click('[aria-label="Send to worker"]');
      await page.wait(${JSON.stringify(`${outsideSelector} .agent-activity[aria-label*="process exited"]`)}, 5000);
      await page.wait(${JSON.stringify(`${outsideSelector} [aria-label="Worker status"][data-status*="process exited"]`)}, 5000);
      console.log(await page.eval(() => document.querySelectorAll(${JSON.stringify(`${outsideSelector} .working-dots`)}).length));
    `,
    })
    expect(outsideFailure).toBe('0')
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
