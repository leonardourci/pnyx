import { PNYX_SKILLS } from '../src/integrations/skills/names.ts'
import { prepareHydraFolder, setupSkills } from '../src/integrations/skills/install.ts'
import { skillReference } from '../src/thread/skill-reference.ts'
import { taskMention, reference } from '../src/mentions/mentions.ts'
import { fileBlock } from '../src/attachments/files.ts'
import { project as projectCommand } from '../src/projects/cli.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
import { fakeCodex } from '../src/test-harness/codex-fixture.ts'
import { hydraSdk } from '../src/test-harness/hydra-host-fixture.ts'

function visibleLabelText({ text }: { text: string | null | undefined }): string {
  return (text ?? '').replaceAll(
    '\u2060',
    '',
  )
}

for (const geometry of [
  false,
  true,
]) {
  test(
    geometry ? 'Composer inline tokens keep text, caret and badges clear at edges and wrapped lines'
      : 'Hydra slash suggestions escape composer clipping and retain insertion, dismissal and mention behavior',
    {
      skip: process.env.PNYX_BROWSER_TESTS !== '1',
      timeout: 120_000,
    },
    async t => {
      const root = realpathSync(mkdtempSync(join(
        tmpdir(),
        'pnyx-slash-browser-',
      )))
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
        '.agents/skills/fixture-cli',
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
        '---\nname: fixture-cli\ndescription: Read and update Pnyx\n---\n',
      )
      prepareHydraFolder({ folder: cwd })
      setupSkills({
        userHome: root,
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
      })
      await commands.hydra([
        'create',
        'default',
      ])

      const sharedProjects = [
        {
          path: join(
            root,
            'team-a/shared',
          ),
          description: 'Deploy team A safely',
          color: 'violet',
        },
        {
          path: join(
            root,
            'team-b/shared',
          ),
          description: 'Deploy team B safely',
          color: 'teal',
        },
      ] as const
      withWriter({
        hydraId: 'default',
        fn: ({ writer }) => {
          const decision = hydraEvent({
            state: writer.state,
            cardId: HYDRA_CARD,
            meta: {
              actor: 'fixture',
              at: '2026-10-23T09:00:00Z',
            },
            change: {
              type: 'board.configured',
              data: hydraConfig({ state: writer.state }),
            },
          })
          assert.ok('event' in decision)
          writer.append({
            event: {
              ...decision.event,
              labelColors: sharedProjects.map(project => ({
                label: project.path,
                color: project.color,
              })),
            },
          })
        },
      })

      for (const {
        path: folder,
        description,
      } of [
          {
            path: join(
              root,
              'ledger',
            ),
            description: 'Deploy ledger safely',
          },
          {
            path: join(
              root,
              'docs-site',
            ),
            description: 'Deploy docs-site safely',
          },
          ...sharedProjects,
        ]) {
        const directory = join(
          folder,
          '.agents/skills/deploy',
        )
        mkdirSync(
          directory,
          { recursive: true },
        )
        writeFileSync(
          join(
            directory,
            'SKILL.md',
          ),
          `---\nname: deploy\ndescription: ${description}\n---\n`,
        )
        const long = join(
          folder,
          '.claude/skills/review-cross-platform-accessibility-and-release-readiness',
        )
        mkdirSync(
          long,
          { recursive: true },
        )
        writeFileSync(
          join(
            long,
            'SKILL.md',
          ),
          '---\nname: review-cross-platform-accessibility-and-release-readiness\ndescription: Review all release checks and report the complete accessibility findings\n---\n',
        )
        await projectCommand([
          'add',
          folder,
        ])
        commands.task([
          'create',
          '--title',
          `Review ${description}`,
          '--project',
          folder,
        ])
      }

      const global = join(
        root,
        '.agents/skills/global-review',
      )
      mkdirSync(
        global,
        { recursive: true },
      )
      writeFileSync(
        join(
          global,
          'SKILL.md',
        ),
        '---\nname: global-review\ndescription: Review local changes\n---\n',
      )
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
          config.hydra.agent = {
            harness: 'codex',
            model: 'gpt-6.1-sol',
          }
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

      for (const [
        family,
        name,
      ] of [
          [
            'codex',
            'native-codex',
          ],
          [
            'claude',
            'native-claude',
          ],
        ]) {
        const directory = join(
          root,
          family!,
          'skills',
          name!,
        )
        mkdirSync(
          directory,
          { recursive: true },
        )
        writeFileSync(
          join(
            directory,
            'SKILL.md',
          ),
          `---\nname: ${name}\ndescription: Native ${family} skill\n---\n`,
        )
      }

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
              cwd: tmpdir(),
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

      const artifacts = process.env.PNYX_BROWSER_ARTIFACTS

      if (artifacts) {
        mkdirSync(
          artifacts,
          { recursive: true },
        )
      }

      if (!geometry) {
        const prefetched = await browser({
          args: ['run'],
          script: `
        let loaded = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          loaded = await page.eval(() => Object.keys(sessionStorage).some(key => key.includes(':skills:')
            && JSON.parse(sessionStorage.getItem(key)).suggestions.some(item => item.command === '$native-codex')));
          if (loaded) break;
          await page.wait(50);
        }
        console.log(loaded && await page.eval(() => !document.querySelector('.slash-menu')));
      `,
        })
        assert.equal(
          prefetched.trim(),
          'true',
        )

        const ordering = await browser({
          args: ['run'],
          script: `
        await page.fill('.hydra-chat textarea', '/');
        await page.wait('.slash-menu [role="option"]');
        console.log(JSON.stringify(await page.eval(() => [...document.querySelectorAll('.slash-menu [role="option"] strong')].map(item => item.textContent))));
      `,
        })
        const orderedCommands: string[] = JSON.parse(ordering)
        assert.ok(orderedCommands.length > 0)
        const names = orderedCommands.map(command => command.slice(1))
        assert.ok(PNYX_SKILLS.every(name => !names.includes(name)))

        if (artifacts) {
          await browser({
            args: [
              'screenshot',
              join(
                artifacts,
                'skills-menu.png',
              ),
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
        await page.type('fixture-c');
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
            command: '/fixture-cli',
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
          return document.querySelector('.draft-skill')?.textContent.includes('/fixture-cli') && input.selectionStart === input.value.length && document.activeElement === input;
        }));
        await page.fill('.hydra-chat textarea', '/fixture-TAIL');
        await page.eval(() => document.querySelector('.hydra-chat textarea').setSelectionRange(9, 9));
        await page.type('c');
        await page.wait('.slash-menu [role="option"]');
        await page.press('ArrowDown');
        await page.press('Enter');
        console.log(await page.eval(() => {
          const input = document.querySelector('.hydra-chat textarea');
          return document.querySelector('.draft-skill')?.textContent.includes('/fixture-cli') && input.value.endsWith(' TAIL') && input.selectionStart === input.value.length - 4 && !document.querySelector('.slash-menu');
        }));
        await page.fill('.hydra-chat textarea', '/fixture-c');
        await page.wait('.slash-menu [role="option"]');
        await page.press('Escape');
        console.log(await page.eval(() => !document.querySelector('.slash-menu') && document.querySelector('.hydra-chat textarea').value === '/fixture-c'));
        await page.eval(() => {
          const send = WebSocket.prototype.send, waiting = [];
          WebSocket.prototype.send = function(payload) {
            if (typeof payload === 'string' && JSON.parse(payload).name === 'catalog') {
              waiting.push(() => new Promise(resolve => {
                const id = JSON.parse(payload).id;
                const received = event => {
                  if (JSON.parse(event.data).id !== id) return;
                  this.removeEventListener('message', received);
                  resolve();
                };
                this.addEventListener('message', received);
                send.call(this, payload);
              }));
            } else {
              send.call(this, payload);
            }
          };
          window.releaseCatalog = async () => {
            WebSocket.prototype.send = send;
            await Promise.all(waiting.map(release => release()));
          };
        });
        await page.fill('.hydra-chat textarea', '/');
        await page.wait('.slash-menu [role="option"]');
        console.log(await page.eval(() => {
          const menu = document.querySelector('.slash-menu'), bounds = menu.getBoundingClientRect();
          return !menu.querySelector('[role="status"]')
            && menu.querySelector('[role="option"][aria-selected="true"]') !== null
            && menu.contains(document.elementFromPoint(bounds.x + 15, bounds.y + 15));
        }));
        await page.press('ArrowDown');
        await page.eval(() => {
          window.selectedSkill = document.querySelector('.slash-menu [aria-selected="true"]').textContent;
          window.selectedCommand = document.querySelector('.slash-menu [aria-selected="true"] strong').textContent;
        });
        await page.eval(() => window.releaseCatalog());
        await page.wait(50);
        console.log(await page.eval(() => document.querySelector('.slash-menu [aria-selected="true"]').textContent
          === window.selectedSkill && !document.querySelector('.slash-menu [role="status"]')));
        await page.press('Enter');
        console.log(await page.eval(() => document.querySelector('.draft-skill')?.textContent.includes(window.selectedCommand)));
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
            'true',
            'true',
          ],
        )
        const restoredCatalog = await browser({
          args: ['run'],
          script: `
        await page.eval(() => {
          const key = Object.keys(sessionStorage).find(key => key.includes(':skills:')
            && JSON.parse(sessionStorage.getItem(key)).suggestions.some(item => item.command === '$native-codex'));
          const saved = JSON.parse(sessionStorage.getItem(key));
          saved.suggestions.push({command: '$cache-restored', description: 'Last loaded skill', source: 'Agent skills'});
          sessionStorage.setItem(key, JSON.stringify(saved));
        });
        await page.open(${JSON.stringify(url)});
        await page.wait('.hydra-chat textarea');
        await page.eval(() => {
          const send = WebSocket.prototype.send, waiting = [];
          WebSocket.prototype.send = function(payload) {
            if (JSON.parse(payload).name === 'catalog') waiting.push(() => send.call(this, payload));
            else send.call(this, payload);
          };
          window.releaseCatalog = () => {
            WebSocket.prototype.send = send;
            for (const release of waiting) release();
          };
        });
        await page.fill('.hydra-chat textarea', '/cache-restored');
        await page.wait('.slash-menu [role="option"]');
        console.log(await page.eval(() => !document.querySelector('.slash-menu [role="status"]')
          && document.querySelector('.slash-menu [role="option"]').textContent.includes('/cache-restored')));
        await page.eval(() => window.releaseCatalog());
        await page.fill('.hydra-chat textarea', '');
      `,
        })
        assert.equal(
          restoredCatalog.trim(),
          'true',
        )

        const discovered = join(
          root,
          '.agents/skills/cache-discovery',
        )
        mkdirSync(
          discovered,
          { recursive: true },
        )
        writeFileSync(
          join(
            discovered,
            'SKILL.md',
          ),
          '---\nname: cache-discovery\ndescription: Newly discovered skill\n---\n',
        )

        const addedCatalog = await browser({
          args: ['run'],
          script: `
        let added = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          await page.fill('.hydra-chat textarea', '/cache-discovery');
          await page.wait(50);
          added = await page.eval(() => !!document.querySelector('.slash-menu [role="option"]'));
          if (added) break;
          await page.fill('.hydra-chat textarea', '');
        }
        console.log(added);
        await page.fill('.hydra-chat textarea', '');
      `,
        })
        assert.equal(
          addedCatalog.trim(),
          'true',
        )
        rmSync(
          discovered,
          {
            recursive: true,
            force: true,
          },
        )

        const removedCatalog = await browser({
          args: ['run'],
          script: `
        let removed = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          await page.fill('.hydra-chat textarea', '/cache-discovery');
          await page.wait(50);
          removed = await page.eval(() => !document.querySelector('.slash-menu [role="option"]')
            && !document.querySelector('.slash-menu')?.textContent.includes('Loading'));
          if (removed) break;
          await page.fill('.hydra-chat textarea', '');
        }
        console.log(removed);
        await page.fill('.hydra-chat textarea', '');
      `,
        })
        assert.equal(
          removedCatalog.trim(),
          'true',
        )

        const switchHarness = ({ harness }: { harness: 'claude' | 'codex' }) => {
          withWriter({
            hydraId: 'default',
            fn: ({ writer }) => {
              const config = structuredClone(hydraConfig({ state: writer.state }))
              config.hydra.agent = {
                harness,
                model: 'default',
              }
              const decision = hydraEvent({
                state: writer.state,
                cardId: HYDRA_CARD,
                meta: {
                  actor: 'fixture',
                  at: '2026-10-23T10:00:02Z',
                },
                change: {
                  type: 'board.configured',
                  data: config,
                },
              })
              assert.ok('event' in decision)
              writer.append({ event: decision.event })
            },
          })
        }

        switchHarness({ harness: 'claude' })
        const nativeClaude = await browser({
          args: ['run'],
          script: `
        let prefetched = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          prefetched = await page.eval(() => Object.keys(sessionStorage).some(key => key.includes(':skills:')
            && JSON.parse(sessionStorage.getItem(key)).suggestions.some(item => item.command === '/native-claude')));
          if (prefetched) break;
          await page.wait(50);
        }
        console.log(prefetched && await page.eval(() => !document.querySelector('.slash-menu')));
        await page.eval(() => {
          const send = WebSocket.prototype.send, waiting = [];
          WebSocket.prototype.send = function(payload) {
            if (JSON.parse(payload).name === 'catalog') waiting.push(() => send.call(this, payload));
            else send.call(this, payload);
          };
          window.releaseCatalog = () => {
            WebSocket.prototype.send = send;
            for (const release of waiting) release();
          };
        });
        await page.fill('.hydra-chat textarea', '/native-');
        await page.wait('.slash-menu [role="option"]');
        console.log(await page.eval(() => document.querySelector('.slash-menu').textContent.includes('/native-claude')
          && !document.querySelector('.slash-menu').textContent.includes('/native-codex')
          && !document.querySelector('.slash-menu [role="status"]')));
      `,
        })
        assert.deepEqual(
          nativeClaude.trim().split('\n'),
          [
            'true',
            'true',
          ],
        )
        switchHarness({ harness: 'codex' })
        const nativeCodex = await browser({
          args: ['run'],
          script: `
        let switched = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          switched = await page.eval(() => document.querySelector('.slash-menu')?.textContent.includes('/native-codex'));
          if (switched) break;
          await page.wait(50);
        }
        console.log(switched && await page.eval(() => !document.querySelector('.slash-menu [role="status"]')));
        await page.eval(() => window.releaseCatalog());
        await page.wait(100);
        console.log(await page.eval(() => document.querySelector('.slash-menu').textContent.includes('/native-codex')));
        await page.fill('.hydra-chat textarea', '');
      `,
        })
        assert.deepEqual(
          nativeCodex.trim().split('\n'),
          [
            'true',
            'true',
          ],
        )

        const hydraIsolation = await browser({
          args: ['run'],
          script: `
        await page.eval(() => {
          const meta = document.querySelector('meta[name=pnyx-hydra]');
          window.originalHydra = meta.content;
          meta.content = 'alternate-cache-fixture';
          const send = WebSocket.prototype.send, waiting = [];
          WebSocket.prototype.send = function(payload) {
            if (JSON.parse(payload).name === 'catalog') waiting.push(() => send.call(this, payload));
            else send.call(this, payload);
          };
          window.releaseCatalog = () => {
            WebSocket.prototype.send = send;
            for (const release of waiting) release();
          };
        });
        await page.fill('.hydra-chat textarea', '/native-');
        await page.wait('.slash-menu [role="status"]');
        console.log(await page.eval(() => !document.querySelector('.slash-menu [role="option"]')
          && document.querySelector('.slash-menu').textContent.includes('Loading')));
        await page.eval(() => { document.querySelector('meta[name=pnyx-hydra]').content = window.originalHydra; });
        await page.fill('.hydra-chat textarea', '');
        await page.fill('.hydra-chat textarea', '/native-');
        await page.wait('.slash-menu [role="option"]');
        console.log(await page.eval(() => !document.querySelector('.slash-menu [role="status"]')
          && document.querySelector('.slash-menu').textContent.includes('/native-codex')));
        await page.eval(() => window.releaseCatalog());
        await page.fill('.hydra-chat textarea', '');
      `,
        })
        assert.deepEqual(
          hydraIsolation.trim().split('\n'),
          [
            'true',
            'true',
          ],
        )

        const unmatchedKeys = await browser({
          args: ['run'],
          script: `
        for (const query of ['/missing-skill', '@missing-task']) {
          await page.fill('.hydra-chat textarea', query);
          await page.press('Tab');
          console.log(await page.eval(() => document.activeElement !== document.querySelector('.hydra-chat textarea')
            && !document.querySelector('.slash-menu') && !document.querySelector('.mention-menu')));
        }
        await page.fill('.hydra-chat textarea', '');
      `,
        })
        assert.deepEqual(
          unmatchedKeys.trim().split('\n'),
          [
            'true',
            'true',
          ],
        )

        const projectSkills = await browser({
          args: ['run'],
          script: `
      await page.fill('.hydra-chat textarea', 'Please run /dep');
      await page.wait('.slash-menu [role="option"]');
      console.log(await page.eval(() => {
        const options = [...document.querySelectorAll('.slash-menu [role="option"]')];
        return options.length === 4 && options[0].getAttribute('aria-selected') === 'true'
          && options.every(option => !!option.querySelector('.project-label'));
      }));
      await page.press('Tab');
      console.log(await page.eval(() => {
        const badge = document.querySelector('.draft-skill'), input = document.querySelector('.hydra-chat textarea');
        return badge?.textContent.includes('/deploy') && badge.querySelector('.project-label')
          && input.value.startsWith('Please run ') && !document.querySelector('.slash-menu');
      }));
      await page.type('then report.');
      console.log(await page.eval(() => {
        ${visibleLabelText.toString()}
        const badge = document.querySelector('.draft-skill'), label = badge.querySelector('.project-label');
        const taskLabel = [...document.querySelectorAll('.card .project-label')].find(item => visibleLabelText({ text: item.textContent }) === visibleLabelText({ text: label.textContent }));
        return !!taskLabel && taskLabel.dataset.labelColor === label.dataset.labelColor
          && document.querySelector('.hydra-chat textarea').value.endsWith('then report.');
      }));
      await page.fill('.hydra-chat textarea', '/global-r');
      await page.wait('.slash-menu [role="option"]');
      console.log(await page.eval(() => document.querySelector('.slash-menu [role="option"] strong').textContent === '/global-review'));
      await page.press('Enter');
      await page.fill('.hydra-chat textarea', '');
    `,
        })
        assert.deepEqual(
          projectSkills.trim().split('\n'),
          [
            'true',
            'true',
            'true',
            'true',
          ],
        )

        for (const project of sharedProjects) {
          const selection = await browser({
            args: ['run'],
            script: `
          await page.fill('.hydra-chat textarea', '/dep');
          await page.wait('.slash-menu [role="option"]');
          console.log(await page.eval(() => {
            const options = [...document.querySelectorAll('.slash-menu [role="option"]')];
            ${visibleLabelText.toString()}
            const shared = options.filter(option => visibleLabelText({ text: option.querySelector('.project-label')?.textContent }) === visibleLabelText({ text: 'shared' }));
            const option = shared.find(option => option.querySelector('.mention-excerpt')?.textContent === ${JSON.stringify(project.description)});
            const color = option?.querySelector('.project-label')?.dataset.labelColor;
            option?.click();
            return shared.length === 2 && color === ${JSON.stringify(project.color)};
          }));
          await page.wait('.draft-skill');
          await page.eval(() => window.dispatchEvent(new Event('pagehide')));
          console.log(JSON.stringify(await page.eval(() => {
            const hydra = document.querySelector('meta[name=pnyx-hydra]').content;
            const draft = JSON.parse(sessionStorage.getItem('pnyx:' + hydra + ':restore')).drafts['$hydra'];
            const match = /\\(pnyx-skill:([^)]*)\\)/.exec(draft);
            return match ? JSON.parse(decodeURIComponent(match[1])) : null;
          })));
          await page.open(${JSON.stringify(url)});
          await page.wait('.draft-skill');
          console.log(await page.eval(() => {
            ${visibleLabelText.toString()}
            const badge = document.querySelector('.draft-skill');
            return badge.textContent.includes('/deploy')
              && visibleLabelText({ text: badge.querySelector('.project-label')?.textContent }) === visibleLabelText({ text: 'shared' })
              && badge.querySelector('.project-label')?.dataset.labelColor === ${JSON.stringify(project.color)};
          }));
          await page.fill('.hydra-chat textarea', '/dep');
          await page.wait('.slash-menu [role="option"]');
          console.log(await page.eval(() => {
            const option = [...document.querySelectorAll('.slash-menu [role="option"]')]
              .find(option => option.querySelector('.mention-excerpt')?.textContent === ${JSON.stringify(project.description)});
            return option?.querySelector('.project-label')?.dataset.labelColor === ${JSON.stringify(project.color)};
          }));
          await page.press('Escape');
          await page.fill('.hydra-chat textarea', '');
        `,
          })
          const [
            menuColor,
            serialized,
            restoredColor,
            reloadedMenuColor,
          ] = selection.trim().split('\n')
          assert.equal(
            menuColor,
            'true',
          )
          assert.deepEqual(
            JSON.parse(serialized!),
            {
              name: 'deploy',
              file: join(
                project.path,
                '.agents/skills/deploy/SKILL.md',
              ),
              project: 'shared',
              projectPath: project.path,
            },
          )
          assert.equal(
            restoredColor,
            'true',
          )
          assert.equal(
            reloadedMenuColor,
            'true',
          )
        }

        const caretDismissal = await browser({
          args: ['run'],
          script: `
        await page.fill('.hydra-chat textarea', 'Keep this /dep');
        await page.wait('.slash-menu [role="option"]');
        await page.press('Home');
        console.log(await page.eval(() => !document.querySelector('.slash-menu')
          && document.querySelector('.hydra-chat textarea').value === 'Keep this /dep'));
        await page.type('Prefix ');
        console.log(await page.eval(() => document.querySelector('.hydra-chat textarea').value === 'Prefix Keep this /dep'));
        await page.fill('.hydra-chat textarea', 'Keep this /dep');
        await page.wait('.slash-menu [role="option"]');
        for (let index = 0; index < 5; index++) await page.press('ArrowLeft');
        console.log(await page.eval(() => !document.querySelector('.slash-menu')
          && document.querySelector('.hydra-chat textarea').value === 'Keep this /dep'));
        await page.type('!');
        console.log(await page.eval(() => document.querySelector('.hydra-chat textarea').value === 'Keep this! /dep'));
        await page.fill('.hydra-chat textarea', '');
      `,
        })
        assert.deepEqual(
          caretDismissal.trim().split('\n'),
          [
            'true',
            'true',
            'true',
            'true',
          ],
        )

        await browser({
          args: ['run'],
          script: `
        await page.fill('.hydra-chat textarea', '/fixture-c');
        await page.wait('.slash-menu [role="option"]');
      `,
        })
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
        await page.wait(100);
        console.log(await page.eval(() => {
          const menu = document.querySelector('.slash-menu'), option = menu.querySelector('[role="option"]');
          const bounds = menu.getBoundingClientRect(), item = option.getBoundingClientRect();
          const anchor = document.querySelector('.hydra-chat textarea').getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
            && Math.abs(bounds.bottom + 8 - anchor.top) < 2
            && option.contains(document.elementFromPoint(item.x + 10, item.y + 10));
        }));
        await page.eval(() => {
          const anchor = document.querySelector('.hydra-chat textarea');
          anchor.style.height = '150px';
          anchor.style.minHeight = '150px';
          anchor.style.maxHeight = '150px';
        });
        await page.wait(100);
        console.log(await page.eval(() => {
          const bounds = document.querySelector('.slash-menu').getBoundingClientRect();
          const anchor = document.querySelector('.hydra-chat textarea').getBoundingClientRect();
          return Math.abs(bounds.bottom + 8 - anchor.top) < 2;
        }));
        await page.eval(() => {
          const input = document.querySelector('.hydra-chat textarea');
          input.style.position = 'fixed';
          input.style.top = '30px';
          input.style.left = '20px';
          input.style.width = '300px';
          input.style.height = '50px';
          input.style.minHeight = '50px';
          input.style.maxHeight = '50px';
          document.dispatchEvent(new Event('scroll'));
        });
        await page.wait(100);
        console.log(await page.eval(() => {
          const menu = document.querySelector('.slash-menu'), bounds = menu.getBoundingClientRect();
          const anchor = document.querySelector('.hydra-chat textarea').getBoundingClientRect();
          const option = menu.querySelector('[role="option"]'), item = option.getBoundingClientRect();
          return Math.abs(bounds.top - anchor.bottom - 8) < 2
            && option.contains(document.elementFromPoint(item.x + 10, item.y + 10));
        }));
        await page.eval(() => {
          document.querySelector('.hydra-chat textarea').style.top = '60px';
          document.dispatchEvent(new Event('scroll'));
        });
        await page.wait(100);
        console.log(await page.eval(() => {
          const bounds = document.querySelector('.slash-menu').getBoundingClientRect();
          const anchor = document.querySelector('.hydra-chat textarea').getBoundingClientRect();
          return Math.abs(bounds.top - anchor.bottom - 8) < 2;
        }));
        await page.press('Escape');
      `,
        })
        assert.deepEqual(
          narrow.trim().split('\n'),
          [
            'true',
            'true',
            'true',
            'true',
          ],
        )
        const longBadge = await browser({
          args: ['run'],
          script: `
      await page.eval(() => document.querySelector('.hydra-chat textarea').removeAttribute('style'));
      await page.fill('.hydra-chat textarea', '/review-cross');
      await page.wait('.slash-menu [role="option"]');
      await page.press('Tab');
      console.log(await page.eval(() => {
        const badge = document.querySelector('.draft-skill'), input = document.querySelector('.hydra-chat textarea');
        return badge.textContent.includes('/review-cross-platform-accessibility-and-release-readiness')
          && badge.querySelector('.project-label') && input.scrollWidth <= input.clientWidth + 1;
      }));
      await page.fill('.hydra-chat textarea', '');
    `,
        })
        assert.equal(
          longBadge.trim(),
          'true',
        )
      }

      if (geometry) {
        await browser({
          args: [
            'resize',
            '1400',
            '1000',
          ],
        })
        const shortSkill = skillReference({
          item: {
            command: '$deploy',
            description: 'Deploy',
            source: 'Project',
            project: 'shared',
            projectPath: sharedProjects[0].path,
            file: join(
              sharedProjects[0].path,
              '.agents/skills/deploy/SKILL.md',
            ),
          },
        })
        const longSkill = skillReference({
          item: {
            command: '$review-cross-platform-accessibility-and-release-readiness',
            description: 'Review',
            source: 'Project',
            project: 'docs-site',
            projectPath: join(
              root,
              'docs-site',
            ),
            file: join(
              root,
              'docs-site/.claude/skills/review-cross-platform-accessibility-and-release-readiness/SKILL.md',
            ),
          },
        })
        const taskToken = taskMention({
          id: 'layout-fixture',
          title: 'Review inline spacing',
        })
        const projectToken = reference({
          kind: 'project',
          value: '/demo/docs-site',
          label: 'docs-site',
        })
        const columnToken = reference({
          kind: 'column',
          value: 'queued',
          label: 'Queued',
        })
        const fileToken = reference({
          kind: 'file',
          value: 'notes.txt',
          label: 'notes.txt',
        })
        const attachment = fileBlock({
          name: 'notes.txt',
          text: 'Synthetic preview file\n',
        })
        const inlineSamples = [
          {
            name: 'wide',
            width: 760,
            text: `${shortSkill} at line start\nText${taskToken}next to${projectToken}.\nWrapped ${longSkill} and ${shortSkill}\n${columnToken}${fileToken}\n[image: /preview/attachments/layout.png]\n${attachment}`,
          },
          {
            name: 'wrapped',
            width: 360,
            text: `${shortSkill}start\nText${taskToken}end\nWrapped long: ${longSkill} and ${shortSkill}\n${projectToken}${columnToken}${fileToken}`,
          },
        ]

        for (const sample of inlineSamples) {
          const layout = await browser({
            args: ['run'],
            script: `
          await page.eval(() => {
            const panel = document.querySelector('.hydra-chat');
            panel.style.width = '${sample.width}px';
            panel.style.flex = '0 0 ${sample.width}px';
          });
          await page.fill('.hydra-chat textarea', ${JSON.stringify(sample.text)});
          await page.wait(100);
          console.log(JSON.stringify(await page.eval(() => {
            const input = document.querySelector('.hydra-chat textarea');
            const mirror = document.querySelector('.draft-mirror');
            const box = document.querySelector('.composer-input').getBoundingClientRect();
            const tokens = [...mirror.querySelectorAll('.draft-token')];
            const probe = mirror.cloneNode(false);
            probe.textContent = input.value;
            probe.style.visibility = 'hidden';
            mirror.parentElement.append(probe);
            const point = offset => {
              const range = document.createRange();
              range.setStart(probe.firstChild, offset);
              range.collapse(true);
              return range.getBoundingClientRect();
            };
            const rects = tokens.flatMap(token => [...(token.querySelector('.draft-card > .attachment-card') ?? token.querySelector('.draft-chip'))
              .getClientRects()].filter(rect => rect.width > 0));
            const contained = rects.every(rect => rect.left >= box.left + 2 && rect.right <= box.right - 2
              && rect.top >= box.top + 2 && rect.bottom <= box.bottom - 2);
            const badges = [...mirror.querySelectorAll('.draft-skill .project-label')].every(label => {
              const badge = label.getBoundingClientRect();
              return [...label.closest('.draft-skill').getClientRects()].some(chip =>
                badge.left >= chip.left + 1 && badge.right <= chip.right - 1
                && badge.top >= chip.top && badge.bottom <= chip.bottom);
            });
            const separated = rects.every((rect, index) => rects.slice(index + 1).every(other =>
              Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) < 1
              || rect.right + 2 <= other.left || other.right + 2 <= rect.left));
            const contentPadding = tokens.every(token => {
              const chip = token.querySelector('.draft-chip');
              if (chip.classList.contains('draft-card')) return true;
              const fragments = [...chip.getClientRects()];
              const content = [...chip.querySelectorAll('svg')].map(icon => icon.getBoundingClientRect());
              const walker = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT);
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!node.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                content.push(...range.getClientRects());
              }
              return content.filter(rect => rect.width > 0).every(rect => fragments.some(fragment =>
                rect.left >= fragment.left && rect.right <= fragment.right
                && rect.top >= fragment.top + 1.5 && rect.bottom <= fragment.bottom - 1.5));
            });
            const joinedControls = [...mirror.querySelectorAll('.draft-skill')].every(skill => {
              const remove = skill.querySelector('.skill-remove');
              const name = remove.getAttribute('aria-label').slice('Remove /'.length);
              const walker = document.createTreeWalker(skill, NodeFilter.SHOW_TEXT);
              let command;
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (node.textContent.includes(name)) { command = node; break; }
              }
              const range = document.createRange();
              range.selectNodeContents(command);
              const fragments = [...range.getClientRects()];
              const first = skill.querySelector('.project-label')?.getBoundingClientRect() ?? fragments[0];
              const last = fragments.at(-1), star = skill.querySelector('.chip-icon').getBoundingClientRect();
              const close = remove.getBoundingClientRect();
              return star.top < first.bottom && star.bottom > first.top && close.top < last.bottom && close.bottom > last.top;
            });
            const caretGaps = tokens.every(token => {
              const chip = token.querySelector('.draft-chip');
              const fragments = [...chip.getClientRects()];
              const before = point(Number(token.dataset.from)), after = point(Number(token.dataset.to));
              const first = fragments[0], last = fragments.at(-1);
              const sameLine = (caret, rect) => caret.top < rect.bottom && caret.bottom > rect.top;
              return (!sameLine(before, first) || before.x + 2 <= first.left)
                && (!sameLine(after, last) || after.x - 2 >= last.right);
            });
            probe.remove();
            const first = tokens[0];
            input.focus();
            input.setSelectionRange(Number(first.dataset.from), Number(first.dataset.from));
            return {contained, badges, separated, contentPadding, caretGaps, joinedControls, noMention: !document.querySelector('.mention-menu'), noOverflow: input.scrollWidth <= input.clientWidth + 1,
              wrapped: rects.length > tokens.length, kinds: [...new Set(tokens.map(token => token.querySelector('.draft-chip').dataset.kind))]};
          })));
        `,
          })
          const measured = JSON.parse(layout)
          assert.equal(
            measured.contained,
            true,
            `${sample.name}: inline boxes stay inside the composer`,
          )
          assert.equal(
            measured.badges,
            true,
            `${sample.name}: project labels stay inside their skill`,
          )
          assert.equal(
            measured.separated,
            true,
            `${sample.name}: inline boxes never overlap`,
          )
          assert.equal(
            measured.contentPadding,
            true,
            `${sample.name}: text and icons have vertical padding`,
          )
          assert.equal(
            measured.caretGaps,
            true,
            `${sample.name}: caret clears both token edges`,
          )
          assert.equal(
            measured.joinedControls,
            true,
            `${sample.name}: icons and remove stay with skill text`,
          )
          assert.equal(
            measured.noMention,
            true,
            `${sample.name}: token text does not open a picker`,
          )
          assert.equal(
            measured.noOverflow,
            true,
            `${sample.name}: draft wraps within the textarea`,
          )

          if (sample.name === 'wrapped') {
            assert.equal(
              measured.wrapped,
              true,
            )
          }

          if (sample.name === 'wide') {
            assert.deepEqual(
              measured.kinds.sort(),
              [
                'column',
                'file',
                'image',
                'project',
                'skill',
                'task',
              ],
            )
          }

          if (artifacts) {
            await browser({
              args: [
                'screenshot',
                join(
                  artifacts,
                  `inline-${sample.name}-caret-before.png`,
                ),
              ],
            })
            await browser({
              args: ['run'],
              script: `
          await page.eval(() => {
            const input = document.querySelector('.hydra-chat textarea'), token = document.querySelector('.draft-token');
            input.setSelectionRange(Number(token.dataset.to), Number(token.dataset.to));
          });
        `,
            })
            await browser({
              args: [
                'screenshot',
                join(
                  artifacts,
                  `inline-${sample.name}-caret-after.png`,
                ),
              ],
            })
          }
        }

        await browser({
          args: ['run'],
          script: 'await page.fill(\'.hydra-chat textarea\', \'\');',
        })
      }

      assert.equal(
        readEvents({ hydraId: 'default' }).some(event => event.type === 'hydra.message' && event.data.action === 'send'),
        false,
      )
    },
  )
}
