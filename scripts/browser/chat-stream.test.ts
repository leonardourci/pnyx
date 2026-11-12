import { taskMention } from '#hydra/mentions.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { logLines, scenarioGroup, until, openPage } from '#test-harness/harness.ts'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { installChatContract, assertChatContract, PAINT_TIMEOUT_MS } from '#test-harness/chat-contract.ts'

const BROWSER_TIMEOUT_MS = 60_000
const BROWSER_POLL_MS = 50
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
// An image chip is one text line tall; anything taller is a picture laid out in the message.
const CHIP_MAX_HEIGHT_PX = 32

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

  const waitFor = async ({
    what,
    condition,
  }: {
    what: string
    condition: string
  }) => evaluate({
    script: `async () => {
      await new Promise((resolve, reject) => {
        const interval = setInterval(check, ${BROWSER_POLL_MS});
        const timer = setTimeout(() => { clearInterval(interval); reject(new Error(${JSON.stringify(`Never saw ${what}`)})); }, ${PAINT_TIMEOUT_MS});
        function check() {
          if (${condition}) { clearTimeout(timer); clearInterval(interval); resolve(); }
        }
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
      waitFor,
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
      const firstText = await until({
        what: 'the page’s line for the time from the owner’s send to the reply’s first text, written with source web',
        check: () => logLines().find(line => line.source === 'web' && line.operation === 'page.first-text'
          && line.hydraId === s.hydraId),
      })
      assert.equal(
        typeof firstText.ms,
        'number',
      )
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
      const socketLines = await until({
        what: 'the page’s socket lines across the restart, sent after it reconnected',
        check: () => {
          const lines = logLines().filter(line => line.source === 'web' && line.operation === 'page.socket'
            && line.hydraId === s.hydraId)

          return lines.some(line => line.status === 'lost') && lines.at(-1)?.status === 'open' ? lines : undefined
        },
      })
      assert.ok(
        socketLines.filter(line => line.status === 'failed').length <= 1,
        'an outage logs at most one failed attempt',
      )
      assert.ok(
        logLines().some(line => line.source === 'web' && line.operation === 'page.snapshot' && line.hydraId === s.hydraId
          && typeof line.ms === 'number'),
        'each snapshot the page applies has its line',
      )
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

      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'hidden-reference',
          '--title',
          'Hidden reference fixture',
          '--brief',
          'An archived task still opens from its message chip.',
        ],
      })
      const hiddenTask = s.task({ key: 'hidden-reference' }).id
      await s.owner({
        args: [
          'task',
          'hide',
          hiddenTask,
        ],
      })
      const defaultPage = await s.owner({ args: ['page'] })
      assert.equal(
        defaultPage.includes('Hidden reference fixture'),
        false,
      )
      const includedPage = await s.owner({
        args: [
          'page',
          '--card',
          hiddenTask,
        ],
      })
      assert.ok(includedPage.includes('Hidden reference fixture'))
      const mention = taskMention({
        id: hiddenTask,
        title: 'Hidden reference fixture',
      })
      pnyx.claude.plan({
        text: `Find the hidden reference ${mention}`,
        reply: `Open ${mention}.`,
      })
      await s.chat({ text: `Find the hidden reference ${mention}` })
      await waitFor({
        what: 'the unloaded task chip',
        condition: `document.querySelector('.messages [data-task-ref="${hiddenTask}"]:not(:disabled)')`,
      })
      await evaluate({ script: `() => { document.querySelector('.messages [data-task-ref="${hiddenTask}"]').click(); return 'chat-assertion-passed'; }` })
      await waitFor({
        what: 'the hidden task detail',
        condition: `document.querySelector('.card[data-task="${hiddenTask}"].selected .card-panel:not([hidden])')`,
      })
      await run({
        args: [
          'open',
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`,
        ],
      })
      await waitFor({
        what: 'the restored hidden task detail',
        condition: `document.querySelector('.card[data-task="${hiddenTask}"].selected .card-panel:not([hidden])')`,
      })
      await s.owner({
        args: [
          'task',
          'move',
          hiddenTask,
          '--to-hydra',
          other.hydraId,
        ],
      })
      await waitFor({
        what: 'the moved card leaving the source',
        condition: `!document.querySelector('.card[data-task="${hiddenTask}"]')`,
      })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'second-hidden-reference',
          '--title',
          'Second hidden fixture',
        ],
      })
      const secondHidden = s.task({ key: 'second-hidden-reference' }).id
      await s.owner({
        args: [
          'task',
          'hide',
          secondHidden,
        ],
      })
      const secondMention = taskMention({
        id: secondHidden,
        title: 'Second hidden fixture',
      })
      pnyx.claude.plan({
        text: `Find the other hidden reference ${secondMention}`,
        reply: `Open ${secondMention}.`,
      })
      await s.chat({ text: `Find the other hidden reference ${secondMention}` })
      await waitFor({
        what: 'another unloaded task chip',
        condition: `document.querySelector('.messages [data-task-ref="${secondHidden}"]:not(:disabled)')`,
      })
      await evaluate({ script: `() => { document.querySelector('.messages [data-task-ref="${secondHidden}"]').click(); return 'chat-assertion-passed'; }` })
      await waitFor({
        what: 'another hidden card after a moved selection',
        condition: `document.querySelector('.card[data-task="${secondHidden}"].selected .card-panel:not([hidden])')`,
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
  'chat renders every Markdown, token and file image and escapes HTML',
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
          '1600',
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
      const tall = document.createElement('canvas');
      tall.width = 780; tall.height = 1688;
      const tallCtx = tall.getContext('2d');
      tallCtx.fillStyle = '#c5e8d6'; tallCtx.fillRect(0, 0, 780, 1688);
      tallCtx.fillStyle = '#246c83'; tallCtx.fillRect(48, 96, 684, 240); tallCtx.fillRect(48, 400, 684, 1100);
      const tallBlob = await new Promise(resolve => tall.toBlob(resolve, 'image/png'));
      const tallResponse = await fetch('attachments', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'image/png' }, body: tallBlob });
      if (!tallResponse.ok) throw new Error('Tall upload failed');
      window.imageFixture.tall = (await tallResponse.json()).path;
      return 'chat-assertion-passed';
    }`,
      })
      await evaluate({
        script: `
      () => {
      const value = (() => {
        const src = window.imageFixture.path;
        return 'Image rendering examples\\n\\nMarkdown image\\n\\n![Markdown preview](' + src + ')\\n\\nImage token\\n\\n[image: ' + src + ']\\n\\nFiles:\\n- ' + src + '\\n- ' + window.imageFixture.small + '\\n\\nPhone screenshots\\n\\n[image: ' + window.imageFixture.tall + '] [image: ' + window.imageFixture.tall + '] ![Tall Markdown](' + window.imageFixture.tall + ')\\n\\nBroken image\\n\\n![Missing preview](' + src.replace(/[^/]+$/, '00000000-0000-4000-8000-000000000000.png') + ')\\n\\n<img src="' + src + '" alt="Literal HTML" onerror="window.imageUnsafe=true">\\n\\n<script>window.imageUnsafe=true</script><b>Escaped HTML</b>\\n\\n![Unsafe preview](javascript:alert(1))\\n\\nRemote images\\n\\n![HTTPS preview](https://images.invalid/preview.png)\\n\\n![HTTP preview](http://images.invalid/preview.png)\\n\\n![Relative remote preview](//images.invalid/preview.png)';
      })();
      document.querySelector('[aria-label="Reply to Hydra"]').focus();
      document.execCommand('insertText', false, value);
      document.querySelector('[aria-label="Send reply"]').click();
      return 'chat-assertion-passed';
    }
    `,
      })
      await waitFor({
        what: 'seven image chips with their previews and one without',
        condition: `document.querySelectorAll('.hydra-chat article.mine .attachment-card').length === 8
          && document.querySelectorAll('.hydra-chat article.mine .card-slot img').length === 7
          && document.querySelectorAll('.hydra-chat article.mine .card-slot img:not([data-loading])').length === 7`,
      })
      await evaluate({
        script: `async () => {
      const content = document.querySelector('.hydra-chat article.mine .markdown');
      const chips = [...content.querySelectorAll('.attachment-card')];
      const images = [...content.querySelectorAll('.card-slot img')];
      if (chips.length !== 8 || images.length !== 7) throw new Error('Expected eight chips and seven previews, got ' + chips.length + ' and ' + images.length);
      await Promise.all(images.map(image => image.decode()));
      if (content.querySelector('script, b, img[alt="Literal HTML"]') || window.imageUnsafe || !content.textContent.includes('<img src=')) throw new Error('HTML must stay literal text');
      const bubble = content.getBoundingClientRect();
      const boxes = chips.map(chip => chip.getBoundingClientRect());
      const oversized = boxes.find(box => box.height > ${CHIP_MAX_HEIGHT_PX} || box.right > bubble.right + 1);
      if (oversized) throw new Error('Image chip is larger than a chip: ' + oversized.width + 'x' + oversized.height);
      const labels = chips.map(chip => chip.textContent);
      if (!labels.includes('Markdown preview') || !labels.includes('Image 1')) throw new Error('Chips lost their labels: ' + labels.join(', '));
      const row = [...content.querySelectorAll('p')].find(paragraph => paragraph.querySelectorAll('.attachment-card').length === 3);
      const tall = [...row.querySelectorAll('.attachment-card')].map(chip => chip.getBoundingClientRect());
      if (tall[1].top !== tall[0].top || tall[2].top !== tall[0].top) throw new Error('Chips written in a row must sit side by side');
      const missing = chips.find(chip => chip.textContent === 'Missing preview');
      if (!missing || missing.querySelector('img')) throw new Error('A missing image must keep its chip without a preview');
      if (![...document.querySelectorAll('.message-image-fallback')].some(node => node.textContent.includes('Unsafe preview'))) throw new Error('Unsafe source lacks fallback');
      if (content.querySelector('a[href="https://images.invalid/preview.png"]')?.textContent !== 'HTTPS preview') throw new Error('HTTPS image must stay a link');
      if (content.querySelector('a[href="http://images.invalid/preview.png"]')?.textContent !== 'HTTP preview') throw new Error('HTTP image must stay a link');
      if (document.querySelector('img[src*="images.invalid"]')) throw new Error('Remote images must not load');
      if (![...content.querySelectorAll('.message-image-fallback')].some(node => node.textContent.includes('Relative remote preview'))) throw new Error('Protocol-relative image must be refused');
      return 'chat-assertion-passed';
    }`,
      })
      await capture({ name: 'images' })
      await run({
        args: ['run'],
        input: `await page.wait('.message-image-fallback', ${PAINT_TIMEOUT_MS}); await page.eval(() => [...document.querySelectorAll('.hydra-chat .attachment-card .card-main')].find(chip => chip.textContent === 'Tall Markdown').click()); await page.wait('.image-viewer img', ${PAINT_TIMEOUT_MS});`,
      })
      await evaluate({
        script: `async () => {
      const viewed = document.querySelector('.image-viewer img');
      await viewed.decode();
      if (!viewed.src.includes('/attachments/')) throw new Error('Viewer lost source');
      if (viewed.getBoundingClientRect().height <= ${CHIP_MAX_HEIGHT_PX} * 4) throw new Error('Viewer must show the image at full size, not as a chip');
      if (!document.querySelector('.image-viewer [aria-label="Copy image"]')) throw new Error('Local viewer lost Copy image');
      return 'chat-assertion-passed';
    }`,
      })

      const uploaded = await run({
        args: ['run'],
        input: 'console.log(JSON.stringify(await page.eval(() => window.imageFixture)));',
      })
      const fixture: unknown = JSON.parse(uploaded.stdout)
      assert.ok(fixture && typeof fixture === 'object')
      assert.ok('path' in fixture && typeof fixture.path === 'string')
      assert.ok('small' in fixture && typeof fixture.small === 'string')
      const src = fixture.path
      const otherSrc = fixture.small
      const hydraImages = `Hydra image reply

Literal example: \`${src}\`

Existing token:
[image: ${src}]

Files:
- ${otherSrc}
- ${src}
- /tmp/not-served.png

Again: [image: ${src}]

![Repeated Markdown](${src})

[image: ${otherSrc}]`
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
        what: 'token and file image chips in the Hydra reply',
        condition: 'document.querySelectorAll(\'.hydra-chat article[aria-label="Hydra"] .card-slot img:not([data-loading])\').length === 6',
      })
      await evaluate({
        script: `async () => {
        const reply = [...document.querySelectorAll('.hydra-chat article[aria-label="Hydra"]')].find(row => row.textContent.includes('Hydra image reply'));
        await Promise.all([...reply.querySelectorAll('.card-slot img')].map(image => image.decode()));
        const labels = [...reply.querySelectorAll('.attachment-card')].map(chip => chip.textContent);
        if (!labels.includes('Image 1')) throw new Error('Image token did not render as a chip: ' + labels.join(', '));
        if (!reply.querySelector('li:first-child .card-slot img')) throw new Error('Files path did not render as a chip');
        if (labels.length !== 7 || reply.querySelectorAll('.card-slot img').length !== 6) throw new Error('Only the unservable file should lack a preview');
        return 'chat-assertion-passed';
      }`,
      })
      await capture({ name: 'hydra-images' })
      await evaluate({
        script: `() => {
          document.querySelector('.hydra-chat article[aria-label="Hydra"] .attachment-card .card-main').click();
          return 'chat-assertion-passed';
        }`,
      })
      await run({
        args: ['run'],
        input: `await page.wait('.image-viewer img', ${PAINT_TIMEOUT_MS});`,
      })
      await run({
        args: [
          'open',
          `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`,
        ],
      })
      await waitFor({
        what: 'every image chip in the Hydra reply after reload',
        condition: 'document.querySelectorAll(\'.hydra-chat article[aria-label="Hydra"] .card-slot img:not([data-loading])\').length === 6',
      })

      const folder = s.folder({ name: 'image-worker' })
      const workerImages = `Worker image reply

![Worker Markdown image](${src})

Files:
- ${otherSrc}

Again: [image: ${src}]`
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
        what: 'every image mention in the task worker message',
        condition: `document.querySelectorAll('[data-task="${task.id}"] .card-current-state .card-slot img:not([data-loading])').length === 3`,
      })
      await evaluate({
        script: `async () => {
        document.querySelector('[data-task="${task.id}"] .card-current-state .show-more')?.click();
        const chips = [...document.querySelectorAll('[data-task="${task.id}"] .card-current-state .attachment-card')];
        await Promise.all(chips.map(chip => chip.querySelector('img').decode()));
        if (!chips.some(chip => chip.textContent === 'Worker Markdown image') || chips.length !== 3) throw new Error('Worker image syntax lost');
        const oversized = chips.map(chip => chip.getBoundingClientRect()).find(box => box.height > ${CHIP_MAX_HEIGHT_PX});
        if (oversized) throw new Error('Current state image chip is larger than a chip: ' + oversized.width + 'x' + oversized.height);
        return 'chat-assertion-passed';
      }`,
      })
      await capture({ name: 'worker-images' })
    } finally {
      await run({ args: ['stop'] })
    }
  },
)

test(
  'chat drafts survive reload and send comment text before its save pause',
  async t => {
    const s = await pnyx.scenario()
    pnyx.claude.plan({
      text: 'Show a passage',
      reply: 'A passage to comment on before sending the latest draft.',
    })
    const wire = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => wire.close())
    const {
      run,
      evaluate,
      waitFor,
    } = await browser({
      s,
      session: 'chat-drafts',
    })
    const url = `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/`

    try {
      await run({
        args: [
          'open',
          url,
        ],
      })
      await waitFor({
        what: 'the composer for the first turn',
        condition: 'document.querySelector(\'[aria-label="Reply to Hydra"]\')',
      })
      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', \'Show a passage\'); await page.click(\'[aria-label="Send reply"]\');',
      })
      const agent = await s.agent({ hydra: true })
      await waitFor({
        what: 'the passage in the chat',
        condition: 'document.querySelector(\'.messages\')?.textContent.includes(\'A passage to comment on\')',
      })
      await evaluate({
        script: `() => {
        localStorage.setItem('pnyx:${s.hydraId}:comments', 'invalid-json');
        return 'chat-assertion-passed';
      }`,
      })
      await run({
        args: [
          'open',
          url,
        ],
      })
      await waitFor({
        what: 'the composer after invalid saved data',
        condition: 'document.querySelector(\'[aria-label="Reply to Hydra"]\')',
      })
      await evaluate({
        script: `async () => {
          const input = document.querySelector('[aria-label="Reply to Hydra"]');
          const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          const edit = (text, caret) => {
            set.call(input, text); input.setSelectionRange(caret, caret);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          };
          edit('[@Fixture](pnyx-task:synthetic-task) tail', 43);
          await new Promise(requestAnimationFrame);
          window.draftChip = document.querySelector('.composer .draft-token');
          if (!window.draftChip) throw new Error('Missing task chip');
          edit('Before ' + input.value, 7);
          const chip = document.querySelector('.composer .draft-token');
          const gap = document.querySelector('.composer [data-draft-gap="0"]');
          if (chip !== window.draftChip || gap.textContent !== 'Before ') throw new Error('Typing did not move the existing chip and mirror together');
          return 'chat-assertion-passed';
        }`,
      })
      await run({
        args: ['run'],
        input: `
          await page.eval(() => {
            const input = document.querySelector('[aria-label="Reply to Hydra"]');
            input.focus();
            const caret = input.value.indexOf(' tail');
            if (caret < 0) throw new Error('Missing text after the chip');
            input.setSelectionRange(caret, caret);
          });
          await page.press('Backspace');
        `,
      })
      await evaluate({
        script: `() => {
          const input = document.querySelector('[aria-label="Reply to Hydra"]');
          if (document.querySelector('.composer .draft-token') || input.value !== 'Before  tail') throw new Error('Backspace did not remove the moved chip');
          return 'chat-assertion-passed';
        }`,
      })
      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', \'Keep this draft\');',
      })
      await run({
        args: [
          'open',
          url,
        ],
      })
      await waitFor({
        what: 'the draft restored after navigation',
        condition: 'document.querySelector(\'[aria-label="Reply to Hydra"]\')?.value === \'Keep this draft\'',
      })
      await evaluate({
        script: `() => {
      window.selectDraftPassage = () => {
      const block = [...document.querySelectorAll('[data-message-block]')].find(el => el.dataset.quote?.includes('A passage to comment on'));
      if (!block) throw new Error('Missing passage');
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode()) && !text.textContent.includes('A passage to comment on')) {}
      if (!text) throw new Error('Missing passage text');
      const range = document.createRange();
      range.setStart(text, 0); range.setEnd(text, 9);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      document.activeElement?.blur();
      document.dispatchEvent(new Event('selectionchange'));
      };
      window.selectDraftPassage();
      return 'chat-assertion-passed';
    }`,
      })
      await waitFor({
        what: 'the selected passage ready for a comment',
        condition: 'document.querySelector(\'[aria-label="Comment on selection"]\')',
      })
      await evaluate({
        script: `async () => {
          document.querySelector('[aria-label="Quote selection"]').click();
          const draft = document.querySelector('[aria-label="Reply to Hydra"]').value;
          if (!draft.includes('Keep this draft') || !draft.includes('> A passage')) throw new Error('Quote did not reach the browser-owned draft immediately');
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          window.selectDraftPassage();
          return 'chat-assertion-passed';
        }`,
      })
      await evaluate({
        script: `() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
      const note = document.querySelector('.comment-card textarea');
      if (!note) throw new Error('Comment field did not open');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(note, 'Latest unpaused comment');
      note.dispatchEvent(new Event('input', { bubbles: true }));
      const button = document.querySelector('[aria-label="Send reply"]');
      if (button.disabled) throw new Error('Send disabled: ' + document.querySelector('[aria-label="Reply to Hydra"]').value);
      button.click();
      return 'chat-assertion-passed';
    }`,
      })
      await until({
        what: 'the draft delivered',
        check: () => s.received({ cwd: agent.cwd }).some(message => message.includes('Keep this draft')),
      })
      const delivered = s.received({ cwd: agent.cwd }).findLast(message => message.includes('Keep this draft'))
      assert.ok(
        delivered?.includes('Latest unpaused comment'),
        delivered?.slice(-1500),
      )
      await waitFor({
        what: 'the sent draft and comments cleared',
        condition: 'document.querySelector(\'[aria-label="Reply to Hydra"]\')?.value === \'\' && !document.querySelector(\'.comment-card\')',
      })
      await run({
        args: [
          'open',
          url,
        ],
      })
      await waitFor({
        what: 'the sent draft stays cleared after reload',
        condition: 'document.querySelector(\'[aria-label="Reply to Hydra"]\')?.value === \'\' && !document.querySelector(\'.comment-card\')',
      })
      await evaluate({ script: `() => { localStorage.removeItem('pnyx:${s.hydraId}:comments'); return 'chat-assertion-passed'; }` })
      await run({
        args: [
          'open',
          url,
        ],
      })
      await waitFor({
        what: 'the clean composer with no saved comments entry',
        condition: 'document.querySelector(\'[aria-label="Reply to Hydra"]\')',
      })
      await evaluate({
        script: `() => {
          if (localStorage.getItem('pnyx:${s.hydraId}:comments') !== null) throw new Error('Clean tab wrote comments without an edit');
          window.draftPeer = window.open(${JSON.stringify(url)}, 'draft-peer');
          if (!window.draftPeer) throw new Error('Second draft tab did not open');
          return 'chat-assertion-passed';
        }`,
      })
      await waitFor({
        what: 'the second tab composer',
        condition: 'window.draftPeer.document.querySelector(\'[aria-label="Reply to Hydra"]\')',
      })
      await evaluate({
        script: `() => {
          const key = 'pnyx:${s.hydraId}:comments';
          const messageId = document.querySelector('article.message[aria-label="Hydra"][data-entry-id]')?.dataset.entryId;
          if (!messageId) throw new Error('Missing reply for the saved comments');
          const comment = { messageId, block: 0, offset: 0, quote: 'A passage', text: 'Saved first' };
          const comments = [{ ...comment, id: 'first' }, { ...comment, id: 'second', text: 'Saved second' }];
          window.draftPeer.localStorage.setItem(key, JSON.stringify({ $hydra: comments }));
          window.dispatchEvent(new Event('pagehide'));
          if (JSON.parse(localStorage.getItem(key)).$hydra.length !== 2) throw new Error('Clean tab overwrote the other tab’s first save');
          window.draftPeer.location.reload();
          return 'chat-assertion-passed';
        }`,
      })
      await waitFor({
        what: 'comments in both tabs after the first save',
        condition: 'document.querySelector(\'.composer-comments\')?.textContent.includes(\'2\') && window.draftPeer.document.querySelector(\'.composer-comments\')?.textContent.includes(\'2\')',
      })
      await evaluate({
        script: `async () => {
          document.querySelector('.composer-comments .card-main').click();
          window.draftPeer.document.querySelector('.composer-comments .card-main').click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const peer = window.draftPeer;
          const key = 'pnyx:${s.hydraId}:comments';
          window.editDraftComment = (target, id, text) => {
            const input = target.document.querySelector('.comments-dialog [data-comment-ref="' + id + '"] textarea');
            if (!input) throw new Error('Missing editable comment ' + id);
            Object.getOwnPropertyDescriptor(target.HTMLTextAreaElement.prototype, 'value').set.call(input, text);
            input.dispatchEvent(new target.Event('input', { bubbles: true }));
          };
          const read = target => {
            const legacy = JSON.parse(target.localStorage.getItem(key) || '{}').$hydra;
            if (legacy) return legacy;
            return Object.keys(target.localStorage).filter(name => name.startsWith(key + ':')).map(name => JSON.parse(target.localStorage.getItem(name)));
          };
          const before = JSON.stringify({ $hydra: read(window) });
          const restore = [window, peer].map(target => {
            const get = target.Storage.prototype.getItem;
            target.Storage.prototype.getItem = function(name) { return name === key ? before : get.call(this, name); };
            return () => { target.Storage.prototype.getItem = get; };
          });
          try {
            window.editDraftComment(window, 'first', 'Concurrent first');
            window.editDraftComment(peer, 'second', 'Concurrent second');
            window.dispatchEvent(new Event('pagehide'));
            peer.dispatchEvent(new peer.Event('pagehide'));
          } finally {
            restore.forEach(reset => reset());
          }
          const saved = read(window);
          if (saved.find(comment => comment.id === 'first')?.text !== 'Concurrent first' || saved.find(comment => comment.id === 'second')?.text !== 'Concurrent second') throw new Error('Simultaneous tab saves lost an independent comment edit');
          if (localStorage.getItem(key) !== null) throw new Error('Legacy comments were not migrated');
          window.draftAdditionReceived = false;
          const added = event => {
            if (event.key === key + ':%24hydra:third') {
              window.draftAdditionReceived = true;
              removeEventListener('storage', added);
            }
          };
          addEventListener('storage', added);
          peer.localStorage.setItem(key + ':%24hydra:third', JSON.stringify({ ...saved[0], id: 'third', text: 'Independent remote addition' }));
          window.dispatchEvent(new Event('pagehide'));
          return 'chat-assertion-passed';
        }`,
      })
      await waitFor({
        what: 'both concurrent edits and the independent addition reaching the first tab',
        condition: 'window.draftAdditionReceived && document.querySelector(\'.comments-dialog [data-comment-ref="first"] textarea\')?.value === \'Concurrent first\' && document.querySelector(\'.comments-dialog [data-comment-ref="second"] textarea\')?.value === \'Concurrent second\'',
      })
      await evaluate({
        script: `async () => {
          const peer = window.draftPeer;
          document.querySelector('.comments-dialog footer button').click();
          peer.location.reload();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          document.querySelector('.composer-comments .card-main').click();
          return 'chat-assertion-passed';
        }`,
      })
      await waitFor({
        what: 'the source tab loading the raw storage fixture',
        condition: 'window.draftPeer.document.querySelector(\'.composer-comments\')?.textContent.includes(\'3\')',
      })
      await evaluate({ script: "() => { window.draftPeer.document.querySelector('.composer-comments .card-main').click(); return 'chat-assertion-passed'; }" })
      await waitFor({
        what: 'both dialogs showing the newly added comment',
        condition: 'document.querySelector(\'.comments-dialog [data-comment-ref="third"]\') && window.draftPeer.document.querySelector(\'.comments-dialog [data-comment-ref="third"]\')',
      })
      await evaluate({
        script: `() => {
          const key = 'pnyx:${s.hydraId}:comments:%24hydra:first';
          const saved = localStorage.getItem(key);
          window.malformedDraftReceived = false;
          const received = event => {
            if (event.key === key && event.newValue === 'invalid-json') {
              window.malformedDraftReceived = true;
              removeEventListener('storage', received);
            }
          };
          addEventListener('storage', received);
          window.draftPeer.localStorage.setItem(key, 'invalid-json');
          window.restoreMalformedDraft = () => window.draftPeer.localStorage.setItem(key, saved);
          return 'chat-assertion-passed';
        }`,
      })
      await waitFor({
        what: 'a malformed record leaving the mounted comment intact',
        condition: 'window.malformedDraftReceived && document.querySelector(\'.comments-dialog [data-comment-ref="first"] textarea\')?.value === \'Concurrent first\'',
      })
      await evaluate({ script: "() => { window.restoreMalformedDraft(); return 'chat-assertion-passed'; }" })
      await evaluate({
        script: `() => {
          const peer = window.draftPeer;
          const key = 'pnyx:${s.hydraId}:comments';
          const set = Storage.prototype.setItem;
          const remove = Storage.prototype.removeItem;
          window.restoreDraftStorage = () => { Storage.prototype.setItem = set; Storage.prototype.removeItem = remove; };
          Storage.prototype.removeItem = function(name) {
            if (name.startsWith(key)) throw new DOMException('Fixture storage failure', 'QuotaExceededError');
            return remove.call(this, name);
          };
          Storage.prototype.setItem = function(name, value) {
            if (name.startsWith(key)) throw new DOMException('Fixture storage failure', 'QuotaExceededError');
            return set.call(this, name, value);
          };
          const edit = (target, id, text) => {
            const input = target.document.querySelector('.comments-dialog [data-comment-ref="' + id + '"] textarea');
            if (!input) throw new Error('Missing editable comment ' + id);
            Object.getOwnPropertyDescriptor(target.HTMLTextAreaElement.prototype, 'value').set.call(input, text);
            input.dispatchEvent(new target.Event('input', { bubbles: true }));
          };
          edit(window, 'first', 'Unsaved local edit');
          document.querySelector('.comments-dialog [data-comment-ref="second"] [aria-label="Remove comment"]').click();
          window.dispatchEvent(new Event('pagehide'));
          window.draftStorageReceived = false;
          const received = event => {
            if (event.key?.startsWith(key) && event.newValue?.includes('Remote first')) {
              window.draftStorageReceived = true;
              removeEventListener('storage', received);
            }
          };
          addEventListener('storage', received);
          edit(peer, 'first', 'Remote first');
          edit(peer, 'second', 'Remote second');
          peer.dispatchEvent(new peer.Event('pagehide'));
          return 'chat-assertion-passed';
        }`,
      })
      await waitFor({
        what: 'the local edit and removal surviving the other tab’s storage event',
        condition: 'window.draftStorageReceived && document.querySelector(\'.comments-dialog [data-comment-ref="first"] textarea\')?.value === \'Unsaved local edit\' && !document.querySelector(\'.comments-dialog [data-comment-ref="second"]\')',
      })
      await evaluate({
        script: `() => {
          window.restoreDraftStorage();
          window.dispatchEvent(new Event('pagehide'));
          window.editDraftComment(window.draftPeer, 'third', 'Another independent edit');
          window.draftPeer.dispatchEvent(new window.draftPeer.Event('pagehide'));
          return 'chat-assertion-passed';
        }`,
      })
      await waitFor({
        what: 'the merged comments reaching the second tab',
        condition: 'window.draftPeer.document.querySelector(\'.comments-dialog [data-comment-ref="first"] textarea\')?.value === \'Unsaved local edit\' && !window.draftPeer.document.querySelector(\'.comments-dialog [data-comment-ref="second"]\')',
      })
      await evaluate({ script: '() => { window.draftPeer.document.documentElement.dataset.draftReload = \'old\'; window.draftPeer.location.reload(); return \'chat-assertion-passed\'; }' })
      await waitFor({
        what: 'the second tab restoring its merged comment',
        condition: '!window.draftPeer.document.documentElement.dataset.draftReload && window.draftPeer.document.querySelector(\'.composer-comments\')?.textContent.includes(\'2\')',
      })
      await evaluate({
        script: `async () => {
          const peer = window.draftPeer;
          peer.document.querySelector('.composer-comments .card-main').click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          if (peer.document.querySelector('.comments-dialog [data-comment-ref="first"] textarea')?.value !== 'Unsaved local edit') throw new Error('Second tab reload lost the merged comment');
          peer.close();
          return 'chat-assertion-passed';
        }`,
      })
      await run({
        args: [
          'open',
          url,
        ],
      })
      await waitFor({
        what: 'the first tab restoring its merged comment',
        condition: 'document.querySelector(\'.composer-comments\')?.textContent.includes(\'2\')',
      })
      await evaluate({
        script: `async () => {
          document.querySelector('.composer-comments .card-main').click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          if (document.querySelector('.comments-dialog [data-comment-ref="first"] textarea')?.value !== 'Unsaved local edit') throw new Error('First tab reload lost the merged comment');
          document.querySelectorAll('.comments-dialog [aria-label="Remove comment"]').forEach(button => button.click());
          document.querySelector('.comments-dialog footer button').click();
          return 'chat-assertion-passed';
        }`,
      })
      await evaluate({
        script: `() => {
        const send = WebSocket.prototype.send;
        window.pendingCreations = [];
        WebSocket.prototype.send = function(frame) {
          const request = typeof frame === 'string' ? JSON.parse(frame) : {};
          if (request.name === 'hydras' && request.args?.[0] === 'create') {
            window.pendingCreations.push([this, frame]); return;
          }
          return send.call(this, frame);
        };
        window.releaseCreation = () => {
          WebSocket.prototype.send = send;
          window.pendingCreations.forEach(([socket, frame]) => send.call(socket, frame));
        };
        return 'chat-assertion-passed';
      }`,
      })
      await run({
        args: ['run'],
        input: `
        await page.click('[aria-label="Create Hydra"]');
        await page.fill('[aria-label="Hydra name"]', 'Draft promotion fixture');
        await page.eval(() => document.querySelector('.hydra-name-editor').requestSubmit());
      `,
      })
      await waitFor({
        what: 'the pending Hydra composer',
        condition: 'document.querySelector(\'base\')?.getAttribute(\'href\')?.includes(\'/pending-\') && document.querySelector(\'[aria-label="Reply to Hydra"]\') && window.pendingCreations.length > 0',
      })
      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', \'Pending draft\');',
      })
      await evaluate({ script: '() => { window.releaseCreation(); return \'chat-assertion-passed\'; }' })
      await waitFor({
        what: 'the Hydra promoted without replacing its draft',
        condition: '!document.querySelector(\'base\')?.getAttribute(\'href\')?.includes(\'/pending-\') && document.querySelector(\'[aria-label="Reply to Hydra"]\')?.value === \'Pending draft\'',
      })
      await run({
        args: ['run'],
        input: 'await page.fill(\'[aria-label="Reply to Hydra"]\', \'Canonical draft\');',
      })
      await evaluate({
        script: `async () => {
          const deadline = performance.now() + ${PAINT_TIMEOUT_MS};
          while (performance.now() < deadline) {
            const identity = document.querySelector('meta[name="pnyx-hydra"]').content;
            const saved = JSON.parse(sessionStorage.getItem('pnyx:' + identity + ':restore') ?? '{}');
            if (saved.drafts?.$hydra === 'Canonical draft') return 'chat-assertion-passed';
            await new Promise(requestAnimationFrame);
          }
          throw new Error('Promoted draft was not saved under the canonical identity');
        }`,
      })
      await run({
        args: ['run'],
        input: 'await page.open(await page.eval(() => location.href));',
      })
      await waitFor({
        what: 'the promoted draft restored under the canonical identity',
        condition: 'document.querySelector(\'[aria-label="Reply to Hydra"]\')?.value === \'Canonical draft\'',
      })
    } finally {
      await run({ args: ['stop'] })
    }
  },
)
