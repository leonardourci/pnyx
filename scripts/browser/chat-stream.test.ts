import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { scenarioGroup, until, openPage } from '#test-harness/harness.ts'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { installChatContract, assertChatContract, PAINT_TIMEOUT_MS } from '#test-harness/chat-contract.ts'

const BROWSER_TIMEOUT_MS = 60_000
const BROWSER_OUTPUT_BYTES = 1024 * 1024
const execute = promisify(execFile)
const cli = fileURLToPath(import.meta.resolve('chrome-devtools-axi/dist/bin/chrome-devtools-axi.js'))
const mcp = fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
const mediaFolder = process.env.PNYX_CHAT_MEDIA
const pnyx = scenarioGroup()
const CONTRACT_COPIES = 12
const REPLAY_SCALE = 0.02
const CONTRACT_START = 'STREAM_CONTRACT_START'
const CONTRACT_END = 'STREAM_CONTRACT_END'

const recordedChat = JSON.parse(readFileSync(
  join(
    dirname(fileURLToPath(import.meta.resolve('#test-harness/chat-contract.ts'))),
    'fixtures',
    'chat-deltas.json',
  ),
  'utf8',
)) as {
  source: string
  visible: string
  deltas: [number, string][]
}

type Scenario = Awaited<ReturnType<typeof pnyx.scenario>>

// A headless browser of the scenario's own, on a free bridge port; it never attaches to another browser.
async function browser({
  s,
  session,
}: {
  s: Scenario
  session: string
}) {
  const socket = createServer()
  await new Promise<void>(resolve => socket.listen(
    0,
    '127.0.0.1',
    resolve,
  ))
  const address = socket.address()
  assert.ok(address && typeof address === 'object')

  await promisify(socket.close.bind(socket))()
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: s.folder({ name: 'browser-home' }),
    TMPDIR: s.folder({ name: 'browser-tmp' }),
    CHROME_DEVTOOLS_AXI_PORT: String(address.port),
    CHROME_DEVTOOLS_AXI_SESSION: `${session}-${process.pid}`,
    CHROME_DEVTOOLS_AXI_MCP_PATH: mcp,
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
    CHROME_DEVTOOLS_AXI_CHROME_ARGS: '--no-sandbox --disable-background-networking --disable-component-update',
  }

  const run = async ({
    args,
    input,
  }: {
    args: string[]
    input?: string
  }) => {
    const running = execute(
      process.execPath,
      [
        cli,
        ...args,
      ],
      {
        env,
        timeout: BROWSER_TIMEOUT_MS,
        maxBuffer: BROWSER_OUTPUT_BYTES,
      },
    )

    if (input !== undefined) {
      assert.ok(running.child.stdin)
      running.child.stdin.end(input)
    }

    return await running
  }

  const evaluate = async ({ script }: { script: string }) => {
    const result = await run({
      args: [
        'eval',
        script,
      ],
    })
    assert.match(
      result.stdout,
      /chat-assertion-passed/,
    )
  }

  const capture = async ({ name }: { name: string }) => {
    if (!mediaFolder) {
      return
    }

    mkdirSync(
      mediaFolder,
      { recursive: true },
    )

    for (const theme of [
      'light',
      'dark',
    ]) {
      await evaluate({ script: `() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.querySelectorAll('.turn-actions details').forEach(element => element.open = true); return 'chat-assertion-passed'; }` })
      const path = join(
        s.folder({ name: 'browser-shots' }),
        `${name}-${theme}.png`,
      )
      await run({
        args: [
          'screenshot',
          path,
        ],
      })
      copyFileSync(
        path,
        join(
          mediaFolder,
          `${name}-${theme}.png`,
        ),
      )
    }
  }

  // Resolves once the page's condition holds, checking on every DOM change.
  const waitFor = async ({
    what,
    condition,
  }: {
    what: string
    condition: string
  }) => evaluate({
    script: `async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`Never saw ${what}`)})); }, ${PAINT_TIMEOUT_MS});
        const check = () => {
          if (${condition}) { clearTimeout(timer); observer.disconnect(); resolve(); }
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        check();
      });
      return 'chat-assertion-passed';
    }`,
  })

  return {
    run,
    evaluate,
    capture,
    waitFor,
  }
}

test(
  'a recorded long reply keeps its revealed content and equals reload and native text',
  async t => {
    const s = await pnyx.scenario()
    const wire = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => wire.close())
    const partial = `${CONTRACT_START}\n\n${Array(CONTRACT_COPIES).fill(recordedChat.source)
      .join('\n\n')}\n\n`
    const answer = `${partial}${CONTRACT_END}`
    const visiblePartial = `${CONTRACT_START}${recordedChat.visible.repeat(CONTRACT_COPIES)}`
    const visibleAnswer = `${visiblePartial}${CONTRACT_END}`
    let streamed = false

    async function* deltas() {
      yield `${CONTRACT_START}\n\n`

      for (let copy = 0; copy < CONTRACT_COPIES; copy++) {
        let previous = 0

        for (const [
          at,
          text,
        ] of recordedChat.deltas) {
          const gap = (at - previous) * REPLAY_SCALE
          previous = at

          if (gap >= 1) {
            await new Promise<void>(resolve => setTimeout(
              resolve,
              gap,
            ))
          }

          yield text
        }

        yield '\n\n'
      }

      streamed = true
    }

    const held = pnyx.claude.plan({
      text: 'Replay the recorded rainwater reply',
      reply: answer,
      stream: deltas(),
      hold: true,
    })
    const {
      run,
      evaluate,
    } = await browser({
      s,
      session: 'chat-contract',
    })
    const url = `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`

    try {
      await run({
        args: [
          'open',
          url,
        ],
      })
      await run({
        args: ['run'],
        input: 'await page.wait(\'[aria-label="Reply to Hydra"]\');',
      })
      await installChatContract({
        evaluate,
        marker: CONTRACT_START,
        expected: visibleAnswer,
      })
      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', "Replay the recorded rainwater reply"); await page.click(\'[aria-label="Send reply"]\');',
      })
      await until({
        what: 'the recorded live prefix',
        check: () => streamed,
      })
      const live = (await wire.command({
        name: 'thread',
        args: ['$hydra'],
      })).thread as ThreadPage
      assert.ok(
        live.conversation!.entries.some(entry => entry.text === partial),
        'the live page must retain every native text part',
      )
      await assertChatContract({
        evaluate,
        expected: visiblePartial,
      })
      held.release()
      const agent = await s.agent({ hydra: true })
      await until({
        what: 'the native final reply',
        check: () => s.answered({ cwd: agent.cwd }) === 1,
      })
      const nativePath = s.state().cards.$hydra!.agent!.transcriptPath
      assert.ok(nativePath)
      const records = readFileSync(
        nativePath,
        'utf8',
      ).trim()
        .split('\n')
        .map(line => JSON.parse(line))
      const native = records.filter(record => record.type === 'assistant').at(-1)
      assert.equal(
        native.message.content,
        answer,
      )
      const final = (await wire.command({
        name: 'thread',
        args: ['$hydra'],
      })).thread as ThreadPage
      assert.ok(final.conversation!.entries.some(entry => entry.text === answer))
      await assertChatContract({
        evaluate,
        expected: visibleAnswer,
        finish: true,
      })
      await run({
        args: [
          'open',
          url,
        ],
      })
      await installChatContract({
        evaluate,
        marker: CONTRACT_START,
        expected: visibleAnswer,
      })
      await assertChatContract({
        evaluate,
        expected: visibleAnswer,
        finish: true,
      })
    } finally {
      held.release()
      await run({ args: ['stop'] })
    }
  },
)

test(
  'recorded chat streams once through handoff, reconnect and Hydra switches',
  async t => {
    const s = await pnyx.scenario()
    const wire = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => wire.close())
    await wire.command({
      name: 'thread',
      args: ['$hydra'],
    })
    const {
      run,
      evaluate,
      capture,
    } = await browser({
      s,
      session: 'chat-stream',
    })

    const native = claudeRecording.turn.find(message => message.type === 'assistant')
    assert.ok(native?.type === 'assistant')
    const commentary = {
      ...native,
      message: {
        ...native.message,
        id: 'synthetic-commentary',
        stop_reason: 'tool_use' as const,
        content: [
          {
            type: 'text' as const,
            text: 'Reading the release checklist.',
            citations: null,
          },
          {
            type: 'tool_use' as const,
            id: 'release-check',
            name: 'Read',
            input: { file_path: 'release.txt' },
          },
        ],
      },
    }
    const held = pnyx.claude.plan({
      text: 'Check the release',
      reply: 'Release checks are complete.',
      partial: 'Release checks',
      hold: true,
      before: [commentary],
    })

    let cleanupFailure: { error: unknown } | undefined

    try {
      await run({
        args: [
          'open',
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`,
        ],
      })
      await run({
        args: [
          'resize',
          '1200',
          '760',
        ],
      })
      await run({
        args: ['run'],
        input: `await page.wait('[aria-label="Hydra conversation"]', ${PAINT_TIMEOUT_MS});`,
      })
      await evaluate({
        script: `() => {
      const region = document.querySelector('[aria-label="Hydra conversation"]');
      if (!region) throw new Error('Missing conversation');
      window.chatProbe = { started: false, gaps: 0, duplicates: 0, samples: 0 };
      window.chatObserver = new MutationObserver(() => {
        const rows = [...region.querySelectorAll('[data-entry-id], [data-progress-id]')];
        const matches = rows.filter(row => row.textContent.includes('Release checks'));
        const probe = window.chatProbe;
        if (probe.started && matches.length === 0) probe.gaps++;
        if (matches.length > 1) probe.duplicates++;
        if (matches.length) probe.started = true;
        probe.samples++;
      });
      window.chatObserver.observe(region, { subtree: true, childList: true, characterData: true });
      return 'chat-assertion-passed';
    }`,
      })
      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', \'Check the release\'); await page.click(\'[aria-label="Send reply"]\');',
      })
      await until({
        what: 'the held agent session to be attached',
        check: () => s.state().cards.$hydra?.agent?.transcriptPath,
      })
      const partialPacket = (await wire.command({
        name: 'thread',
        args: ['$hydra'],
      })).thread as ThreadPage
      assert.ok(partialPacket.conversation?.entries.some(entry => entry.text === 'Release checks'))
      await evaluate({
        script: `async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Partial text never appeared')); }, ${PAINT_TIMEOUT_MS});
        const check = () => {
          const row = [...document.querySelectorAll('.hydra-chat article[data-streaming]')].find(row => row.textContent.includes('Release checks'));
          if (row) { clearTimeout(timer); observer.disconnect(); resolve(); }
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        check();
      });
      return 'chat-assertion-passed';
    }`,
      })
      const state = s.state()
      await capture({ name: 'partial' })
      const transcript = state.cards.$hydra?.agent?.transcriptPath
      assert.ok(transcript)
      const owner = partialPacket.conversation?.entries.find(entry => entry.role === 'user' && entry.text === 'Check the release')
      assert.ok(owner?.at)
      appendFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: owner.at,
          message: commentary.message,
        })}\n`,
      )
      await evaluate({
        script: `async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Commentary never moved into progress')); }, ${PAINT_TIMEOUT_MS});
        const check = () => {
          const progress = [...document.querySelectorAll('.hydra-chat [data-progress-id]')];
          if (progress.some(row => row.textContent.includes('Reading the release checklist.'))) { clearTimeout(timer); observer.disconnect(); resolve(); }
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, childList: true });
        check();
      });
      const rows = [...document.querySelectorAll('.hydra-chat [data-entry-id], .hydra-chat [data-progress-id]')];
      if (rows.filter(row => row.textContent.includes('Reading the release checklist.')).length !== 1) throw new Error('Commentary duplicated or missing');
      const progress = rows.find(row => row.textContent.includes('Reading the release checklist.'));
      const answer = document.querySelector('.hydra-chat article[data-streaming]');
      if (!answer || !(progress.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)) throw new Error('Progress appears after its reply');
      return 'chat-assertion-passed';
    }`,
      })
      await capture({ name: 'native' })
      held.release()
      await until({
        what: 'the recorded turn to finish',
        check: () => s.answered({ cwd: state.cards.$hydra!.agent!.cwd! }) === 1,
      })
      await evaluate({
        script: `async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Final text never appeared')); }, ${PAINT_TIMEOUT_MS});
        const check = () => {
          const rows = [...document.querySelectorAll('.hydra-chat article.message')];
          if (rows.some(row => row.textContent.includes('Release checks are complete.'))) { clearTimeout(timer); observer.disconnect(); resolve(); }
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        check();
      });
      window.chatObserver.disconnect();
      if (!window.chatProbe.started || window.chatProbe.gaps || window.chatProbe.duplicates) throw new Error(JSON.stringify(window.chatProbe));
      const rows = [...document.querySelectorAll('.hydra-chat [data-entry-id], .hydra-chat [data-progress-id]')];
      if (rows.filter(row => row.textContent.includes('Release checks are complete.')).length !== 1) throw new Error('Final text duplicated');
      if (rows.filter(row => row.textContent.includes('Check the release')).length !== 1) throw new Error('Owner text duplicated');
      return 'chat-assertion-passed';
    }`,
      })
      await pnyx.restart()
      await evaluate({
        script: `async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Reconnect lost history')); }, ${PAINT_TIMEOUT_MS});
        const check = () => {
          const rows = [...document.querySelectorAll('.hydra-chat [data-entry-id], .hydra-chat [data-progress-id]')];
          const progress = rows.some(row => row.dataset.progressId && row.textContent.includes('Reading the release checklist.'))
          if (rows.filter(row => row.textContent.includes('Release checks are complete.')).length === 1 && progress) { clearTimeout(timer); observer.disconnect(); resolve(); }
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        check();
      });
      return 'chat-assertion-passed';
    }`,
      })
      await evaluate({
        script: `() => {
      if (document.querySelector('.hydra-chat .trace')) throw new Error('Focus mode showed a tool call');
      return 'chat-assertion-passed';
    }`,
      })
      await capture({ name: 'final' })
      const other = await pnyx.scenario()
      await other.owner({
        args: [
          'hydra',
          'send',
          '--text',
          'A separate conversation',
        ],
      })
      await until({
        what: 'the separate Hydra turn to finish',
        check: () => other.state().cards.$hydra?.sessionActivity === 'finished',
      })
      await evaluate({
        script: `() => {
        window.scopeLeaks = 0;
        window.scopeObserver = new MutationObserver(() => {
          const current = document.querySelector('main[data-hydra]')?.dataset.hydra;
          const text = document.querySelector('[aria-label="Hydra conversation"]')?.textContent ?? '';
          if (current === ${JSON.stringify(other.hydraId)} && text.includes('Release checks are complete.')) window.scopeLeaks++;
          if (current === ${JSON.stringify(s.hydraId)} && text.includes('A separate conversation')) window.scopeLeaks++;
        });
        window.scopeObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        return 'chat-assertion-passed';
      }`,
      })
      await run({
        args: ['run'],
        input: `await page.wait('.hydras-panel [data-hydra="${other.hydraId}"] .hydra-name'); await page.click('.hydras-panel [data-hydra="${other.hydraId}"] .hydra-name');`,
      })
      await evaluate({
        script: `async () => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Hydra switch lost its conversation')); }, ${PAINT_TIMEOUT_MS});
          const check = () => {
            const text = document.querySelector('[aria-label="Hydra conversation"]')?.textContent ?? '';
            if (text.includes('A separate conversation') && !text.includes('Release checks')) { clearTimeout(timer); observer.disconnect(); resolve(); }
          };
          const observer = new MutationObserver(check);
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
          check();
        });
        return 'chat-assertion-passed';
      }`,
      })
      await run({
        args: ['run'],
        input: `await page.click('.hydras-panel [data-hydra="${s.hydraId}"] .hydra-name');`,
      })
      await evaluate({
        script: `async () => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Returning to Hydra lost its conversation')); }, ${PAINT_TIMEOUT_MS});
          const check = () => {
            const text = document.querySelector('[aria-label="Hydra conversation"]')?.textContent ?? '';
            if (text.includes('Release checks are complete.') && !text.includes('A separate conversation')) { clearTimeout(timer); observer.disconnect(); resolve(); }
          };
          const observer = new MutationObserver(check);
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
          check();
        });
        window.scopeObserver.disconnect();
        if (window.scopeLeaks) throw new Error('Hydra switch painted another conversation');
        return 'chat-assertion-passed';
      }`,
      })
    } catch (error) {
      try {
        const diagnostic = await run({ args: ['console'] })
        process.stderr.write(diagnostic.stdout)
        await capture({ name: 'failure' })
      } catch (diagnosticError) {
        console.error(
          'Chat diagnostics failed:',
          diagnosticError,
        )
      }

      throw error
    } finally {
      held.release()

      try {
        await run({ args: ['stop'] })
      } catch (stopError) {
        cleanupFailure = { error: stopError }
        console.error(
          'Browser cleanup failed:',
          stopError,
        )
      }
    }

    if (cleanupFailure) {
      throw cleanupFailure.error
    }
  },
)

test(
  'a live turn shows its status at once, keeps tool calls in progress, and keeps a refused message with a retry',
  async t => {
    const s = await pnyx.scenario()
    const wire = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => wire.close())
    await wire.command({
      name: 'thread',
      args: ['$hydra'],
    })
    const {
      run,
      evaluate,
      capture,
      waitFor,
    } = await browser({
      s,
      session: 'chat-status',
    })
    const native = claudeRecording.turn.find(message => message.type === 'assistant')
    assert.ok(native?.type === 'assistant')
    const commentary = {
      ...native,
      message: {
        ...native.message,
        id: 'synthetic-status',
        stop_reason: 'tool_use' as const,
        content: [
          {
            type: 'text' as const,
            text: 'Reading the deploy notes.',
            citations: null,
          },
          {
            type: 'tool_use' as const,
            id: 'deploy-notes',
            name: 'Bash',
            input: { command: 'cat deploy-notes.txt' },
          },
        ],
      },
    }
    const partial = claudeRecording.turn.find(message => message.type === 'stream_event')
    assert.ok(partial?.type === 'stream_event')
    const thinking = {
      ...partial,
      event: {
        type: 'content_block_start' as const,
        index: 0,
        content_block: {
          type: 'thinking' as const,
          thinking: '',
          signature: '',
        },
      },
    }
    const thinkingDone = {
      ...partial,
      event: {
        type: 'content_block_stop' as const,
        index: 0,
      },
    }
    let finishTools = () => {}
    const toolsFinished = new Promise<void>(resolve => {
      finishTools = resolve
    })

    async function* deltas() {
      yield 'The deploy'
      await toolsFinished
    }

    let releaseHeld = () => {}
    const hydraRow = `.hydras-panel [data-hydra="${s.hydraId}"] .hydra-running`

    try {
      await run({
        args: [
          'open',
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`,
        ],
      })
      await run({
        args: [
          'resize',
          '1200',
          '760',
        ],
      })
      await waitFor({
        what: 'the Hydra idle in the list',
        condition: `document.querySelector('${hydraRow}:not([data-running])')`,
      })

      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', \'Prepare the status fixture\'); await page.click(\'[aria-label="Send reply"]\');',
      })
      const previousAgent = await s.agent({ hydra: true })
      await until({
        what: 'the previous turn to finish',
        check: () => s.answered({ cwd: previousAgent.cwd }) === 1,
      })
      const path = s.state().cards.$hydra!.agent!.transcriptPath!
      appendFileSync(
        path,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2000-01-01T00:00:00Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'previous-call',
                name: 'Bash',
                input: { command: 'pwd' },
              },
            ],
          },
        })}\n${JSON.stringify({
          type: 'user',
          timestamp: '2000-01-01T00:00:01Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'previous-call',
                content: '/fixture',
              },
            ],
          },
        })}\n`,
      )
      await until({
        what: 'the older native action to reach the socket',
        check: () => wire.actions.$hydra?.at === '2000-01-01T00:00:00Z',
      })

      const held = pnyx.claude.plan({
        text: 'Check the deploy',
        reply: 'The deploy is ready.',
        stream: deltas(),
        hold: true,
        before: [
          partial,
          thinking,
        ],
        after: [
          thinkingDone,
          commentary,
        ],
      })
      releaseHeld = held.release

      // The send is held in the page, so what shows comes from the page alone.
      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', \'Check the deploy\');',
      })
      await evaluate({
        script: `async () => {
      const send = WebSocket.prototype.send;
      window.heldFrames = [];
      window.releaseFrames = () => { WebSocket.prototype.send = send; window.heldFrames.forEach(([socket, data]) => send.call(socket, data)); };
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.includes('"args":["send"')) { window.heldFrames.push([this, data]); return; }
        return send.call(this, data);
      };
      document.querySelector('[aria-label="Send reply"]').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!window.heldFrames.length) throw new Error('The send was not held');
      const mine = [...document.querySelectorAll('.hydra-chat article.mine[data-sending]')].filter(row => row.textContent.includes('Check the deploy'));
      if (mine.length !== 1) throw new Error('The sent message did not show at once');
      if (!document.querySelector('.hydra-chat .chat-running')) throw new Error('The working dots did not start with the send');
      window.releaseFrames();
      return 'chat-assertion-passed';
    }`,
      })
      await capture({ name: 'status-sent' })
      await until({
        what: 'the live thinking fact on the socket',
        check: () => wire.actions.$hydra?.thinking === true,
      })
      await waitFor({
        what: 'thinking from the live turn despite the older transcript action',
        condition: 'document.querySelector(\'.chat-running .action-text\')?.textContent === \'Thinking\'',
      })
      await capture({ name: 'status-thinking' })
      held.release()
      await waitFor({
        what: 'the running shell command before its native record arrives',
        condition: 'document.querySelector(\'.chat-running .action-text\')?.textContent === \'Running a command\'',
      })
      await capture({ name: 'status-command' })
      const packet = (await wire.command({
        name: 'thread',
        args: ['$hydra'],
      })).thread as ThreadPage
      const owner = packet.conversation?.entries.find(entry => entry.role === 'user' && entry.text === 'Check the deploy')
      assert.ok(owner?.at)
      appendFileSync(
        s.state().cards.$hydra!.agent!.transcriptPath!,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: owner.at,
          message: commentary.message,
        })}\n${JSON.stringify({
          type: 'user',
          timestamp: owner.at,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'deploy-notes',
                content: 'Ship on Friday.',
              },
            ],
          },
        })}\n`,
      )
      await waitFor({
        what: 'the Hydra running in the list',
        condition: `document.querySelector('${hydraRow}[data-running]')`,
      })
      await s.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({ focusMode: false }),
        ],
      })
      await waitFor({
        what: 'the tool call inside progress with a plain label',
        condition: `[...document.querySelectorAll('.hydra-chat .turn-progress .trace summary')].some(row => row.textContent.includes('deploy-notes.txt') && !row.textContent.includes('{'))
          && [...document.querySelectorAll('.hydra-chat .trace')].every(trace => trace.closest('.turn-progress'))`,
      })
      await evaluate({
        script: `() => {
      const row = [...document.querySelectorAll('.hydra-chat .turn-progress .trace')].find(trace => trace.querySelector('summary').textContent.includes('deploy-notes.txt'));
      const fold = row.closest('.turn-actions').querySelector('details');
      if (fold.open || row.open) throw new Error('Progress did not start collapsed');
      fold.open = true;
      row.querySelector('summary').click();
      if (!row.open) throw new Error('The tool row did not open');
      if (!row.querySelector('[aria-label="Input"]')?.textContent.includes('deploy-notes.txt')) throw new Error('The opened row did not show the call');
      if (!row.querySelector('[aria-label="Output"]')?.textContent.includes('Ship on Friday.')) throw new Error('The opened row did not show the output');
      return 'chat-assertion-passed';
    }`,
      })
      await capture({ name: 'status-tools' })

      await s.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({ focusMode: true }),
        ],
      })
      await waitFor({
        what: 'focus mode hide the tool call and keep the commentary and working dots',
        condition: `!document.querySelector('.hydra-chat .trace')
          && [...document.querySelectorAll('.hydra-chat [data-progress-id]')].some(row => row.textContent.includes('Reading the deploy notes.'))
          && document.querySelector('.hydra-chat .chat-running')`,
      })
      await capture({ name: 'status-focus' })

      finishTools()
      await waitFor({
        what: 'the turn to end with the Hydra idle and the working dots gone',
        condition: `[...document.querySelectorAll('.hydra-chat article.message')].some(row => row.textContent.includes('The deploy is ready.'))
          && !document.querySelector('.hydra-chat .chat-running')
          && document.querySelector('${hydraRow}:not([data-running])')`,
      })

      // The server's answer to a refused send, delivered in place of the real one.
      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', \'Check the rollback\');',
      })
      await evaluate({
        script: `() => {
      const send = WebSocket.prototype.send;
      window.restoreSend = () => { WebSocket.prototype.send = send; };
      WebSocket.prototype.send = function (data) {
        if (typeof data !== 'string' || !data.includes('"args":["send"')) return send.call(this, data);
        const frame = JSON.parse(data);
        setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'error', scope: frame.scope, id: frame.id, error: 'Hydra refused this message.', code: 'VALIDATION_ERROR', saved: false }) })));
      };
      document.querySelector('[aria-label="Send reply"]').click();
      return 'chat-assertion-passed';
    }`,
      })
      await waitFor({
        what: 'the refused message kept as not sent, without the working dots',
        condition: `[...document.querySelectorAll('.hydra-chat article.mine[data-unsent]')].filter(row => row.textContent.includes('Check the rollback')).length === 1
          && !document.querySelector('.hydra-chat .chat-running')`,
      })
      await capture({ name: 'status-unsent' })
      await run({
        args: [
          'open',
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`,
        ],
      })
      await waitFor({
        what: 'the refused message still not sent after a reload',
        condition: '[...document.querySelectorAll(\'.hydra-chat article.mine[data-unsent]\')].filter(row => row.textContent.includes(\'Check the rollback\')).length === 1',
      })
      pnyx.claude.plan({
        text: 'Check the rollback',
        reply: 'The rollback is ready.',
      })
      await evaluate({
        script: `() => {
      [...document.querySelectorAll('.hydra-chat .message-meta [role=button]')].find(button => button.textContent === 'Retry').click();
      return 'chat-assertion-passed';
    }`,
      })
      await waitFor({
        what: 'the retried message sent once and answered',
        condition: `[...document.querySelectorAll('.hydra-chat article.mine')].filter(row => row.textContent.includes('Check the rollback')).length === 1
          && !document.querySelector('.hydra-chat [data-unsent]')
          && [...document.querySelectorAll('.hydra-chat article.message')].some(row => row.textContent.includes('The rollback is ready.'))`,
      })
      assert.equal(
        s.events().filter(event => event.type === 'hydra.message' && event.data.text === 'Check the rollback').length,
        1,
      )

      // The server records the message, but the page hears a refusal first.
      pnyx.claude.plan({
        text: 'Check the logs',
        reply: 'The logs are clean.',
      })
      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', \'Check the logs\');',
      })
      await evaluate({
        script: `() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data !== 'string' || !data.includes('"args":["send"')) return send.call(this, data);
        WebSocket.prototype.send = send;
        const frame = JSON.parse(data);
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'error', scope: frame.scope, id: frame.id, error: 'Hydra refused this message.', code: 'VALIDATION_ERROR', saved: false }) }));
        return send.call(this, data);
      };
      document.querySelector('[aria-label="Send reply"]').click();
      return 'chat-assertion-passed';
    }`,
      })
      await waitFor({
        what: 'the recorded message shown once as sent and answered',
        condition: `[...document.querySelectorAll('.hydra-chat article.mine')].filter(row => row.textContent.includes('Check the logs')).length === 1
          && !document.querySelector('.hydra-chat [data-unsent]')
          && [...document.querySelectorAll('.hydra-chat article.message')].some(row => row.textContent.includes('The logs are clean.'))`,
      })
      assert.equal(
        s.events().filter(event => event.type === 'hydra.message' && event.data.text === 'Check the logs').length,
        1,
      )
    } catch (error) {
      process.stderr.write((await run({ args: ['console'] })).stdout)
      throw error
    } finally {
      finishTools()
      releaseHeld()
      await s.owner({
        args: [
          'settings',
          'set',
          '--json',
          JSON.stringify({ focusMode: true }),
        ],
      })
      await run({ args: ['stop'] })
    }
  },
)

test(
  'chat renders safe Markdown and HTML images through the attachment viewer',
  async () => {
    const s = await pnyx.scenario()
    const {
      run,
      evaluate,
      capture,
      waitFor,
    } = await browser({
      s,
      session: 'chat-images',
    })

    try {
      await run({
        args: [
          'open',
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`,
        ],
      })
      await run({
        args: [
          'resize',
          '1200',
          '1200',
        ],
      })
      await run({
        args: ['run'],
        input: `await page.wait('[aria-label="Reply to Hydra"]', ${PAINT_TIMEOUT_MS});`,
      })
      await evaluate({
        script: `async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1200; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#246c83'; ctx.fillRect(0, 0, 1200, 360);
      ctx.fillStyle = '#c5e8d6'; ctx.font = '48px sans-serif';
      ctx.fillText('Synthetic image preview', 48, 96);
      ctx.fillRect(48, 160, 220, 140); ctx.fillRect(304, 200, 220, 100);
      ctx.fillRect(560, 130, 220, 170); ctx.fillRect(816, 180, 220, 120);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const token = document.querySelector('meta[name=pnyx-token]').content;
      const response = await fetch('attachments', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'image/png' }, body: blob });
      if (!response.ok) throw new Error('Upload failed');
      window.imageFixture = await response.json();
      const small = document.createElement('canvas');
      small.width = 120; small.height = 36;
      small.getContext('2d').drawImage(canvas, 0, 0, 120, 36);
      const smallBlob = await new Promise(resolve => small.toBlob(resolve, 'image/png'));
      const smallResponse = await fetch('attachments', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'image/png' }, body: smallBlob });
      if (!smallResponse.ok) throw new Error('Small upload failed');
      window.imageFixture.small = (await smallResponse.json()).path;
      const sized = await fetch('attachments', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'image/png' }, body: blob });
      const large = await fetch('attachments', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'image/png' }, body: blob });
      const height = await fetch('attachments', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'image/png' }, body: smallBlob });
      if (!sized.ok || !large.ok || !height.ok) throw new Error('Dimension fixture upload failed');
      window.imageFixture.sized = (await sized.json()).path;
      window.imageFixture.large = (await large.json()).path;
      window.imageFixture.height = (await height.json()).path;
      return 'chat-assertion-passed';
    }`,
      })
      await evaluate({
        script: `
      () => {
      const value = (() => {
        const src = window.imageFixture.path;
        return 'Image rendering examples\\n\\nSmall Markdown image\\n\\n![Small preview](' + window.imageFixture.small + ')\\n\\nSized HTML image\\n\\n<img src="' + window.imageFixture.sized + '" alt="Sized preview" width="240" height="72" title="Image title" onerror="window.imageUnsafe=true" style="display:none">\\n\\nLarge HTML image\\n\\n<img src="' + window.imageFixture.large + '" alt="Large preview" width="2400" height="720">\\n\\nHeight-only HTML image\\n\\n<img src="' + window.imageFixture.height + '" alt="Height-only preview" height="72">\\n\\nBroken image\\n\\n<img src="' + src.replace(/[^/]+$/, '00000000-0000-4000-8000-000000000000.png') + '" alt="Missing preview" width="1000" height="1000">\\n\\n<img src="javascript:alert(1)" alt="Unsafe preview">\\n\\n<script>window.imageUnsafe=true</script><b>Escaped HTML</b>';
      })();
      document.querySelector('[aria-label="Reply to Hydra"]').focus();
      document.execCommand('insertText', false, value);
      document.querySelector('[aria-label="Send reply"]').click();
      return 'chat-assertion-passed';
    }
    `,
      })
      await run({
        args: ['run'],
        input: `await page.wait('.hydra-chat .markdown', ${PAINT_TIMEOUT_MS});`,
      })
      await capture({ name: 'images' })
      await evaluate({
        script: `async () => {
      const images = [...document.querySelectorAll('.hydra-chat .message-image img')];
      if (images.length !== 4) throw new Error('Expected four inline images, got ' + images.length);
      await Promise.all(images.map(image => image.complete ? Promise.resolve() : new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; })));
      const sized = images.find(image => image.alt === 'Sized preview');
      if (sized.getAttribute('width') !== '240' || sized.getAttribute('height') !== '72' || sized.title !== 'Image title') throw new Error('Allowed attributes lost');
      if (sized.hasAttribute('onerror') || sized.hasAttribute('style') && sized.style.display === 'none' || window.imageUnsafe) throw new Error('Unsafe HTML ran');
      if (document.querySelector('.hydra-chat .markdown script, .hydra-chat .markdown b')) throw new Error('Other HTML rendered');
      if (images.some(image => !image.naturalWidth || image.getBoundingClientRect().width > image.closest('.markdown').getBoundingClientRect().width + 1)) throw new Error('Image exceeds bubble or failed');
      const heightOnly = images.find(image => image.alt === 'Height-only preview');
      if (Math.abs(heightOnly.getBoundingClientRect().height - 72) > 1 || Math.abs(heightOnly.getBoundingClientRect().width - 240) > 1) throw new Error('Height-only size ignored');
      if (Math.abs(sized.getBoundingClientRect().width - 240) > 1) throw new Error('Width ignored');
      if (![...document.querySelectorAll('.message-image-fallback')].some(node => node.textContent.includes('Unsafe preview'))) throw new Error('Unsafe source lacks fallback');
      return 'chat-assertion-passed';
    }`,
      })
      await run({
        args: ['run'],
        input: `await page.wait('.message-image-fallback', ${PAINT_TIMEOUT_MS}); await page.click('[aria-label="Show image: Sized preview"]'); await page.wait('.image-viewer img', ${PAINT_TIMEOUT_MS});`,
      })
      await evaluate({
        script: `() => {
      if (!document.querySelector('.image-viewer img').src.includes('/attachments/')) throw new Error('Viewer lost source');
      return 'chat-assertion-passed';
    }`,
      })

      const home = process.env.PNYX_HOME
      assert.ok(home)
      const attachments = join(
        home,
        'hydras',
        s.hydraId,
        'attachments',
      )
      const [
        attachment,
        otherAttachment,
      ] = readdirSync(attachments)
      assert.ok(attachment)
      assert.ok(otherAttachment)
      const src = join(
        attachments,
        attachment,
      )
      const otherSrc = join(
        attachments,
        otherAttachment,
      )
      const hydraImages = `Hydra image reply

Literal example: \`${src}\`

Existing token:
[image: ${src}]

Files:
- ${otherSrc}
- ${src}
- /tmp/not-served.png

Again: [image: ${src}]

![Duplicate Markdown](${src})

<img src="${src}" alt="Duplicate HTML" width="240">`
      pnyx.claude.plan({
        text: 'Show the Hydra images',
        reply: hydraImages,
      })
      await run({
        args: [
          'open',
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`,
        ],
      })
      await s.chat({ text: 'Show the Hydra images' })
      await waitFor({
        what: 'automatic token and file images in the Hydra reply',
        condition: `document.querySelectorAll('.hydra-chat article[aria-label="Hydra"] .message-image img').length === 2
          && [...document.querySelectorAll('.hydra-chat article[aria-label="Hydra"] .message-image img')].every(image => image.complete && image.naturalWidth > 0)`,
      })
      await evaluate({
        script: `() => {
        const reply = [...document.querySelectorAll('.hydra-chat article[aria-label="Hydra"]')].find(row => row.textContent.includes('Hydra image reply'));
        if (!reply.querySelector('img[alt="Image 1"]')) throw new Error('First image token did not render inline');
        if (!reply.querySelector('li:first-child .message-image img')) throw new Error('Files path did not render inline');
        if (reply.querySelector('img[alt="Duplicate Markdown"], img[alt="Duplicate HTML"]')) throw new Error('Later mentions must not render inline');
        if (new Set([...reply.querySelectorAll('.message-image img')].map(image => image.src)).size !== 2) throw new Error('Distinct automatic sources lost');
        if (reply.querySelectorAll('.attachment-card').length !== 5) throw new Error('Repeated image mentions must stay chips');
        return 'chat-assertion-passed';
      }`,
      })
      await capture({ name: 'hydra-images' })
      await run({
        args: ['run'],
        input: `await page.click('.hydra-chat article[aria-label="Hydra"] [aria-label="Show image: Image 1"]'); await page.wait('.image-viewer img', ${PAINT_TIMEOUT_MS});`,
      })
      await run({
        args: [
          'open',
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`,
        ],
      })
      await waitFor({
        what: 'automatic images still deduplicated after reload',
        condition: 'document.querySelectorAll(\'.hydra-chat article[aria-label="Hydra"] .message-image img\').length === 2',
      })

      const folder = s.folder({ name: 'image-worker' })
      const workerImages = `Worker image reply

![Worker Markdown image](${src})

<img src="${otherSrc}" alt="Worker HTML image" width="240" height="72">`
      pnyx.claude.plan({
        text: 'Show the worker images',
        reply: workerImages,
      })
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          'Worker image examples',
          '--key',
          'image-worker',
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'start',
          'image-worker',
          '--prompt',
          'Show the worker images',
        ],
      })
      await until({
        what: 'the worker image reply to finish',
        check: () => s.task({ key: 'image-worker' }).sessionActivity === 'finished',
      })
      const worker = s.as({ agent: await s.agent({ cwd: folder }) })
      await worker.run({
        args: [
          'task',
          'status',
          'image-worker',
          'working',
          '--note',
          workerImages,
        ],
      })
      const task = s.task({ key: 'image-worker' })
      await run({
        args: ['run'],
        input: `await page.click('[data-task="${task.id}"]');`,
      })
      await waitFor({
        what: 'Markdown and HTML images in the task worker message',
        condition: `document.querySelectorAll('[data-task="${task.id}"] .card-current-state .message-image img').length === 2
          && [...document.querySelectorAll('[data-task="${task.id}"] .card-current-state .message-image img')].every(image => image.complete && image.naturalWidth > 0)`,
      })
      await evaluate({
        script: `() => {
        document.querySelector('[data-task="${task.id}"] .card-current-state .show-more')?.click();
        const images = [...document.querySelectorAll('[data-task="${task.id}"] .card-current-state .message-image img')];
        if (!images.some(image => image.alt === 'Worker Markdown image') || !images.some(image => image.alt === 'Worker HTML image')) throw new Error('Worker image syntax lost');
        return 'chat-assertion-passed';
      }`,
      })
      await capture({ name: 'worker-images' })
    } finally {
      await run({ args: ['stop'] })
    }
  },
)
