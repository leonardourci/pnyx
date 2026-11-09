import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { scenarioGroup, until, openPage } from '#test-harness/harness.ts'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'

const BROWSER_TIMEOUT_MS = 60_000
const PAINT_TIMEOUT_MS = 30_000
const BROWSER_OUTPUT_BYTES = 1024 * 1024
const execute = promisify(execFile)
const cli = fileURLToPath(import.meta.resolve('chrome-devtools-axi/dist/bin/chrome-devtools-axi.js'))
const mcp = fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'))
const mediaFolder = process.env.PNYX_CHAT_MEDIA
const pnyx = scenarioGroup()

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
      CHROME_DEVTOOLS_AXI_SESSION: `chat-stream-${process.pid}`,
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
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Tool trace never appeared')); }, ${PAINT_TIMEOUT_MS});
        const check = () => {
          if (document.querySelector('.hydra-chat .trace')) { clearTimeout(timer); observer.disconnect(); resolve(); }
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
          if (rows.filter(row => row.textContent.includes('Release checks are complete.')).length === 1 && document.querySelector('.hydra-chat .trace')) { clearTimeout(timer); observer.disconnect(); resolve(); }
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        check();
      });
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
