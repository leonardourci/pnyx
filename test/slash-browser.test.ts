import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { commands } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { hydraConfig, hydraEvent, HYDRA_CARD } from '../src/core/hydra.ts'
import { startServer } from '../src/server/server.ts'
import { readEvents, withWriter } from '../src/store/hydra-store.ts'
import { fakeCodex } from './codex-fixture.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

test(
  'Hydra slash suggestions escape composer clipping and retain insertion, dismissal and mention behavior',
  {
    skip: process.env.PNYX_BROWSER_TESTS !== '1',
    timeout: 120_000,
  },
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-slash-browser-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'home',
    )
    process.env.PNYX_SEMANTIC = 'off'
    process.env.CLAUDE_CONFIG_DIR = join(
      root,
      'claude',
    )
    process.env.CODEX_HOME = join(
      root,
      'codex',
    )
    const cwd = join(
      root,
      'home/hydras/default/agent',
    )
    const skill = join(
      cwd,
      '.agents/skills/inscribe',
    )
    mkdirSync(
      skill,
      { recursive: true },
    )
    writeFileSync(
      join(
        skill,
        'SKILL.md',
      ),
      '---\nname: inscribe\ndescription: Save Hydra memory\n---\n',
    )
    await commands.hydra([
      'create',
      'default',
    ])
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const pushed = decidePush({
          state: writer.state,
          key: 'codex:slash-fixture',
          input: {
            title: 'Hydra',
            activity: 'finished',
            agent: {
              provider: 'codex',
              sessionId: 'slash-fixture',
              cwd,
            },
          },
          meta: {
            actor: 'fixture',
            at: '2026-10-23T10:00:00Z',
          },
        })
        assert.ok('event' in pushed)
        writer.append({ event: pushed.event })
        const config = structuredClone(hydraConfig({ state: writer.state }))
        config.hydra.session = 'codex:slash-fixture'
        config.hydra.agent = { harness: 'codex' }
        const configure = hydraEvent({
          state: writer.state,
          cardId: '$board',
          meta: {
            actor: 'fixture',
            at: '2026-10-23T10:00:01Z',
          },
          change: {
            type: 'board.configured',
            data: config,
          },
        })
        assert.ok('event' in configure)
        writer.append({ event: configure.event })
        assert.equal(
          writer.state.cards[HYDRA_CARD]?.agent?.cwd,
          cwd,
        )
      },
    })
    const codex = fakeCodex({
      root,
      models: ['gpt-6.1-sol'],
    })
    const server = await startServer({
      hydraId: 'default',
      port: 0,
      homes: [],
      query: hydraSdk().query,
      spawnCodex: codex.spawnCodex,
      catalogLocations: {
        home: root,
        claude: process.env.CLAUDE_CONFIG_DIR,
        codex: process.env.CODEX_HOME,
      },
    })
    const listener = createServer()
    await new Promise<void>(resolve => listener.listen(
      0,
      '127.0.0.1',
      resolve,
    ))
    const address = listener.address()
    assert.ok(address && typeof address === 'object')
    await promisify(listener.close.bind(listener))()
    const browserEnv = {
      ...process.env,
      CHROME_DEVTOOLS_AXI_SESSION: `pnyx-slash-${address.port}`,
      CHROME_DEVTOOLS_AXI_PORT: String(address.port),
      CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '',
      CHROME_DEVTOOLS_AXI_BROWSER_URL: '',
      CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: '',
      CHROME_DEVTOOLS_AXI_HEADED: '0',
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: join(
        root,
        'chrome',
      ),
    }
    const browser = ({
      args,
      script,
    }: {
      args: string[]
      script?: string
    }): Promise<string> =>
      new Promise((
        resolve,
        reject,
      ) => {
        const child = execFile(
          'chrome-devtools-axi',
          args,
          {
            env: browserEnv,
            timeout: 45_000,
            maxBuffer: 2 * 1024 * 1024,
          },
          (
            error,
            stdout,
            stderr,
          ) => {
            if (error) {
              reject(new Error(`${error.message}\n${stdout}\n${stderr}`))

              return
            }

            resolve(stdout)
          },
        )
        child.stdin?.end(script)
      })
    t.after(async () => {
      try {
        await browser({ args: ['stop'] })
      } finally {
        await server.close()

        for (const child of codex.children) {
          child.kill()
        }

        rmSync(
          root,
          {
            recursive: true,
            force: true,
          },
        )
      }
    })
    const url = `http://127.0.0.1:${server.port}/hydra/default/`

    try {
      await browser({
        args: [
          'open',
          url,
        ],
      })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BRIDGE_NOT_READY')) {
        throw error
      }

      await browser({
        args: [
          'open',
          url,
        ],
      })
    }

    const initial = await browser({
      args: ['run'],
      script: `
        await page.open(${JSON.stringify(url)});
        await page.wait('.hydra-chat textarea');
        await page.fill('.hydra-chat textarea', '');
        await page.click('.hydra-chat textarea');
        await page.press('/');
        await page.type('ins');
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await page.eval(() => !!document.querySelector('.slash-menu [role="option"]'))) break;
          await page.wait(25);
        }
        console.log(JSON.stringify(await page.eval(() => {
          const option = document.querySelector('.slash-menu [role="option"]');
          const bounds = option?.getBoundingClientRect();
          return {
            command: option?.querySelector('strong').textContent,
            reachable: !!option && option.contains(document.elementFromPoint(bounds.x + 10, bounds.y + 10)),
            clipping: getComputedStyle(document.querySelector('.composer-input')).overflow,
          };
        })));
      `,
    })
    const artifacts = process.env.PNYX_BROWSER_ARTIFACTS

    if (artifacts) {
      mkdirSync(
        artifacts,
        { recursive: true },
      )
      await browser({
        args: [
          'screenshot',
          join(
            artifacts,
            'slash-menu.png',
          ),
        ],
      })
    }

    assert.deepEqual(
      JSON.parse(initial),
      {
        command: '$inscribe',
        reachable: true,
        clipping: 'hidden',
      },
    )
    const interactions = await browser({
      args: ['run'],
      script: `
        await page.click('.slash-menu [role="option"]');
        console.log(await page.eval(() => {
          const input = document.querySelector('.hydra-chat textarea');
          return input.value === '$inscribe ' && input.selectionStart === 10 && document.activeElement === input;
        }));
        await page.fill('.hydra-chat textarea', '/inTAIL');
        await page.eval(() => document.querySelector('.hydra-chat textarea').setSelectionRange(3, 3));
        await page.type('s');
        await page.wait('.slash-menu [role="option"]');
        await page.press('ArrowDown');
        await page.press('Enter');
        console.log(await page.eval(() => {
          const input = document.querySelector('.hydra-chat textarea');
          return input.value === '$inscribe TAIL' && input.selectionStart === 10 && !document.querySelector('.slash-menu');
        }));
        await page.fill('.hydra-chat textarea', '/ins');
        await page.wait('.slash-menu [role="option"]');
        await page.press('Escape');
        console.log(await page.eval(() => !document.querySelector('.slash-menu') && document.querySelector('.hydra-chat textarea').value === '/ins'));
        await page.eval(() => {
          const send = WebSocket.prototype.send, waiting = [];
          WebSocket.prototype.send = function(payload) {
            if (typeof payload === 'string' && JSON.parse(payload).name === 'catalog') {
              waiting.push(() => send.call(this, payload));
            } else {
              send.call(this, payload);
            }
          };
          window.releaseCatalog = () => {
            WebSocket.prototype.send = send;
            for (const release of waiting) release();
          };
        });
        await page.fill('.hydra-chat textarea', '/');
        await page.wait('.slash-menu [role="status"]');
        console.log(await page.eval(() => {
          const menu = document.querySelector('.slash-menu'), bounds = menu.getBoundingClientRect();
          return menu.querySelector('[role="status"]').textContent.includes('Loading')
            && menu.contains(document.elementFromPoint(bounds.x + 15, bounds.y + 15));
        }));
        await page.eval(() => window.releaseCatalog());
        await page.wait('.slash-menu [role="option"]');
        await page.fill('.hydra-chat textarea', '/missing');
        await page.wait('.slash-menu [role="status"]');
        console.log(await page.eval(() => {
          const menu = document.querySelector('.slash-menu'), bounds = menu.getBoundingClientRect();
          return !menu.querySelector('[role="option"]') && menu.contains(document.elementFromPoint(bounds.x + 15, bounds.y + 15));
        }));
        await page.fill('.hydra-chat textarea', '@Que');
        await page.wait('.mention-menu [role="option"]');
        console.log(await page.eval(() => {
          const option = document.querySelector('.mention-menu [role="option"]'), bounds = option.getBoundingClientRect();
          return option.querySelector('strong').textContent === 'Queued' && option.contains(document.elementFromPoint(bounds.x + 10, bounds.y + 10));
        }));
        await page.press('Escape');
        await page.fill('.hydra-chat textarea', '');
      `,
    })
    assert.deepEqual(
      interactions.trim().split('\n'),
      [
        'true',
        'true',
        'true',
        'true',
        'true',
        'true',
      ],
    )
    await browser({
      args: [
        'resize',
        '375',
        '600',
      ],
    })
    const narrow = await browser({
      args: ['run'],
      script: `
        await page.fill('.hydra-chat textarea', '/ins');
        await page.wait('.slash-menu [role="option"]');
        console.log(await page.eval(() => {
          const menu = document.querySelector('.slash-menu'), option = menu.querySelector('[role="option"]');
          const bounds = menu.getBoundingClientRect(), item = option.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
            && option.contains(document.elementFromPoint(item.x + 10, item.y + 10));
        }));
        await page.press('Escape');
      `,
    })
    assert.equal(
      narrow.trim(),
      'true',
    )
    assert.equal(
      readEvents({ hydraId: 'default' }).some(event => event.type === 'hydra.message' && event.data.action === 'send'),
      false,
    )
  },
)
