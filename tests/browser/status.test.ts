import { beforeAll, expect, test } from 'vitest'
import { chrome } from './chrome.ts'
import { workerLine } from '../setup/worker-log.ts'
import { rows, startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx
const EXITED_PROCESS_PID = '2147483647'
beforeAll(async () => {
  pnyx = await startPnyx()
})

async function openChat({
  hydraId,
  taskId,
}: {
  hydraId: string
  taskId: string
}) {
  const selector = `[data-hydra="${hydraId}"] [data-task="${taskId}"]`
  await chrome({
    args: [
      'open',
      `http://127.0.0.1:${pnyx.port()}/hydra/${hydraId}/`,
    ],
  })
  await chrome({
    script: `
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

async function recordBadges({ selectors }: { selectors: Record<string, string> }) {
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
      const readBadges = () => Object.fromEntries(Object.entries(${JSON.stringify(selectors)})
        .map(([name, selector]) => [name, document.querySelector(selector)?.textContent]));
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

async function releaseSends() {
  await chrome({
    script: `
    await page.eval(() => {
      for (const {socket, message} of window.heldSends.splice(0)) window.sendSocketMessage.call(socket, message);
    });
  `,
  })
}

const turns = [
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
]

test(
  'hook activity updates the card and chat without adding event history',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'event-diet',
        '--title',
        'Quiet event history',
      ],
    })
    const observe = async ({ activity }: { activity: string }) => hydra.owner({
      args: [
        'push',
        '--key',
        'event-diet',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        activity,
        agent: {
          provider: 'claude-code',
          sessionId: 'event-diet',
        },
        source: {
          adapter: 'hooks',
          instanceId: 'claude',
          objectId: 'event-diet',
          observedAt: new Date().toISOString(),
        },
      }),
    })
    await observe({ activity: 'finished' })
    const task = await hydra.task({ key: 'event-diet' })
    const selector = await openChat({
      hydraId: hydra.id,
      taskId: task.id,
    })
    await status({
      selector,
      label: 'Idle',
    })
    await observe({ activity: 'working' })
    await status({
      selector,
      label: 'Thinking',
    })
    await observe({ activity: 'finished' })
    await status({
      selector,
      label: 'Idle',
    })
    await observe({ activity: 'finished' })
    const noise = rows({
      text: "select type from events where hydra_id = $1 and type in ('card.pushed', 'session.observed', 'card.observed')",
      values: [hydra.id],
    })
    expect(noise).toEqual([])
    expect(rows({
      text: "select type from events where hydra_id = $1 and type = 'task.created'",
      values: [hydra.id],
    })).toEqual([{ type: 'task.created' }])
  },
)

test(
  'Hydra first send shows Starting… on the first frame, then Thinking, Working and Idle',
  async () => {
    const hydra = await pnyx.hydra()
    const hydraChat = `[data-hydra="${hydra.id}"] .hydra-chat`
    const badge = `${hydraChat} [aria-label="Hydra status"]`
    await chrome({
      script: `
      await page.open(${JSON.stringify(`http://127.0.0.1:${pnyx.port()}/hydra/${hydra.id}/`)});
      await page.wait('${hydraChat} [aria-label="Reply to Hydra"]', 5000);
    `,
    })
    await recordBadges({ selectors: { hydra: badge } })

    for (const {
      text,
      label,
      tool,
    } of turns) {
      const turn = pnyx.claude.plan({
        hydra: hydra.id,
        text,
        tool,
        hold: true,
      })

      try {
        const started = await chrome({
          script: `
          await page.eval(() => { window.badgeFrames = []; });
          await page.fill('${hydraChat} [aria-label="Reply to Hydra"]', ${JSON.stringify(text)});
          await page.wait('${hydraChat} [aria-label="Send reply"]:not(:disabled)', 5000);
          await page.click('${hydraChat} [aria-label="Send reply"]');
          console.log(JSON.stringify(await page.eval(() => window.firstSentFrame)));
        `,
        })
        expect(JSON.parse(started)).toEqual({ hydra: 'Starting…' })
        await releaseSends()
        const sampled = await chrome({
          script: `
          await page.wait('${badge}[data-status="${label}"]', 5000);
          await page.eval(() => new Promise(requestAnimationFrame));
          console.log(JSON.stringify(await page.eval(() => ({
            active: window.badgeFrames.filter(frame => frame.hydra === ${JSON.stringify(label)}).length,
            interrupted: window.badgeFrames.slice(window.sendFrames.hydra).filter(frame => !['Starting…', 'Thinking', 'Working'].includes(frame.hydra)),
          }))));
        `,
        })
        expect(JSON.parse(sampled).active).toBeGreaterThan(0)
        expect(JSON.parse(sampled).interrupted).toEqual([])
      } finally {
        turn.release()
      }

      const dots = await chrome({
        script: `
        await page.wait('${badge}[data-status="Idle"]', 5000);
        console.log(await page.eval(() => document.querySelectorAll('${hydraChat} .chat-running-status .working-dots').length));
      `,
      })
      expect(dots).toBe('0')
    }
  },
)

test(
  'worker first send shows Starting… before attachment, reports a refused start and follows later live turns',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'live-badges' })
    await hydra.owner({
      args: [
        'project',
        'add',
        folder,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'live-badges',
        '--title',
        'Task live-badges',
        '--project',
        folder,
        '--folder',
        folder,
      ],
    })
    const task = await hydra.task({ key: 'live-badges' })
    const selector = await openChat({
      hydraId: hydra.id,
      taskId: task.id,
    })
    await recordBadges({
      selectors: {
        pill: `${selector} .activity-text`,
        task: `${selector} [aria-label="Worker status"]`,
      },
    })

    const firstSend = await chrome({
      script: `
      await page.fill(${JSON.stringify(`${selector} [aria-label="Message worker"]`)}, 'Start the never-attached worker');
      await page.wait(${JSON.stringify(`${selector} [aria-label="Send to worker"]:not(:disabled)`)}, 5000);
      await page.click(${JSON.stringify(`${selector} [aria-label="Send to worker"]`)});
      console.log(JSON.stringify(await page.eval(() => window.firstSentFrame)));
    `,
    })
    expect(JSON.parse(firstSend)).toEqual({
      pill: 'Starting…',
      task: 'Starting…',
    })
    expect((await hydra.task({ key: 'live-badges' })).agent).toBeUndefined()
    await releaseSends()
    await status({
      selector,
      label: 'Project live-badges is not a git repository',
    })
    expect((await hydra.task({ key: 'live-badges' })).agent).toBeUndefined()
    await hydra.owner({
      args: [
        'task',
        'start',
        task.id,
        '--in-place',
        '--harness',
        'claude',
      ],
    })
    await until({
      what: 'the in-place worker start to end',
      check: async () => (await hydra.task({ key: 'live-badges' })).status === 'idle',
    })

    for (const {
      text,
      label,
      tool,
    } of turns) {
      const turn = pnyx.claude.plan({
        hydra: hydra.id,
        match: ({ text: prompt }) => prompt.includes(text),
        tool,
        hold: true,
      })

      try {
        const started = await chrome({
          script: `
          await page.eval(() => { window.badgeFrames = []; });
          await page.fill(${JSON.stringify(`${selector} [aria-label="Message worker"]`)}, ${JSON.stringify(text)});
          await page.wait(${JSON.stringify(`${selector} [aria-label="Send to worker"]:not(:disabled)`)}, 5000);
          await page.click(${JSON.stringify(`${selector} [aria-label="Send to worker"]`)});
          console.log(JSON.stringify(await page.eval(() => window.firstSentFrame)));
        `,
        })
        expect(JSON.parse(started)).toEqual({
          pill: 'Starting…',
          task: 'Starting…',
        })

        await releaseSends()
        await status({
          selector,
          label,
        })
        const sampled = await chrome({
          script: `
          await page.eval(() => new Promise(requestAnimationFrame));
          console.log(JSON.stringify(await page.eval(() => {
            const frames = window.badgeFrames.slice(window.sendFrames.worker);
            const active = ['Starting…', 'Thinking', 'Working'];
            return {
              active: frames.filter(frame => frame.pill === ${JSON.stringify(label)} && frame.task === ${JSON.stringify(label)}).length,
              interrupted: frames.filter(frame => !active.includes(frame.pill) || !active.includes(frame.task)),
              disagreements: frames.filter(frame => frame.pill !== frame.task),
            };
          })));
        `,
        })
        expect(JSON.parse(sampled).active).toBeGreaterThan(0)
        expect(JSON.parse(sampled).interrupted).toEqual([])
        expect(JSON.parse(sampled).disagreements).toEqual([])
        expect((await hydra.task({ key: 'live-badges' })).status).toBe('running')
      } finally {
        turn.release()
      }

      await status({
        selector,
        label: 'Idle',
      })
      const dots = await chrome({
        script: `console.log(await page.eval(() => document.querySelectorAll(${JSON.stringify(`${selector} .chat-running-status .working-dots`)}).length));`,
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
    const hydraChat = `[data-hydra="${hydra.id}"] .hydra-chat`
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
    await chrome({
      script: `
      await page.fill('${hydraChat} [aria-label="Reply to Hydra"]', 'Refuse Hydra badge turn');
      await page.click('${hydraChat} [aria-label="Send reply"]');
    `,
    })
    const result = await chrome({
      script: `
      await page.fill(${JSON.stringify(`${selector} [aria-label="Message worker"]`)}, 'Refuse worker badge turn');
      await page.wait(${JSON.stringify(`${selector} [aria-label="Send to worker"]:not(:disabled)`)}, 5000);
      await page.click(${JSON.stringify(`${selector} [aria-label="Send to worker"]`)});
      await page.wait('${hydraChat} [aria-label="Hydra status"][data-status*="refused this turn"]', 5000);
      await page.wait(${JSON.stringify(`${selector} .agent-activity[aria-label*="refused this turn"]`)}, 5000);
      await page.wait(${JSON.stringify(`${selector} [aria-label="Worker status"][data-status*="refused this turn"]`)}, 5000);
      console.log(await page.eval(() => document.querySelectorAll(${JSON.stringify(`${hydraChat} .chat-running-status .working-dots, ${selector} .chat-running-status .working-dots`)}).length));
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
        await page.fill('${hydraChat} [aria-label="Reply to Hydra"]', 'Recover Hydra badge turn');
        await page.click('${hydraChat} [aria-label="Send reply"]');
        await page.wait('${hydraChat} [data-status="Thinking"]', 5000);
      `,
      })
    } finally {
      recovery.release()
    }

    await chrome({ script: `await page.wait('${hydraChat} [data-status="Idle"]', 5000);` })
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
      await page.fill(${JSON.stringify(`${outsideSelector} [aria-label="Message worker"]`)}, 'Try the outside route');
      await page.wait(${JSON.stringify(`${outsideSelector} [aria-label="Send to worker"]:not(:disabled)`)}, 5000);
      await page.click(${JSON.stringify(`${outsideSelector} [aria-label="Send to worker"]`)});
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
      await page.wait('dialog[aria-label="Oracle"] [role="combobox"][aria-label="Oracle"]', 5000);
      await page.fill('dialog[aria-label="Oracle"] [role="combobox"][aria-label="Oracle"]', 'blocked-in-done');
      await page.wait('.oracle-card .agent-activity', 5000);
      console.log(await page.eval(() => document.querySelector('.oracle-card .agent-activity')?.getAttribute('aria-label')));
    `,
    })
    expect(preview).toBe('Blocked')
  },
)
