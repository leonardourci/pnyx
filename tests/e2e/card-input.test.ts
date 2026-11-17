import { beforeAll, expect, test } from 'vitest'
import { openHydra } from '../setup/browser.ts'
import { git } from '../setup/upgrade.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'Ideas saves without a repository and both card composers start in the selected repository copy',
  async () => {
    const hydra = await pnyx.hydra()
    const repository = hydra.folder({ name: 'card-repository' })
    git({
      cwd: repository,
      args: [
        'init',
        '-q',
        '-b',
        'main',
      ],
    })
    git({
      cwd: repository,
      args: [
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'Initial project',
      ],
    })
    await hydra.owner({
      args: [
        'project',
        'add',
        repository,
      ],
    })
    let releaseCreate: (() => void) | undefined
    let creatingTask: string | undefined
    const prematureReads: string[] = []
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: async ({ page }) => {
        await page.addInitScript(() => {
          const save = Storage.prototype.setItem

          // eslint-disable-next-line pnyx/object-params -- Browser Storage owns write signatures.
          Storage.prototype.setItem = function(
            key,
            value,
          ) {
            if (key.endsWith(':draft')) {
              throw new DOMException(
                'Storage full',
                'QuotaExceededError',
              )
            }

            save.call(
              this,
              key,
              value,
            )
          }
        })
        await page.routeWebSocket(
          /\/ws\?/,
          // eslint-disable-next-line pnyx/object-params -- Playwright owns the socket callback.
          socket => {
            const server = socket.connectToServer()
            // eslint-disable-next-line pnyx/object-params -- Playwright owns the frame callback.
            socket.onMessage(message => {
              const frame = JSON.parse(String(message))

              if (creatingTask && (frame.name === 'thread' || frame.name === 'page')
                && frame.args?.includes(`task:${creatingTask}`)) {
                prematureReads.push(frame.name)
              }

              if (frame.name === 'task' && frame.args?.[0] === 'create' && (frame.args?.includes('An unassigned idea') || frame.args?.includes('A new quick task'))) {
                creatingTask = frame.args[frame.args.indexOf('--event-id') + 1]

                releaseCreate = () => {
                  creatingTask = undefined
                  server.send(message)
                }
              } else {
                server.send(message)
              }
            })
          },
        )
      },
    })
    const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)

    try {
      await workspace.getByRole(
        'button',
        {
          name: 'New task in Ideas',
          exact: true,
        },
      ).click()
      const form = workspace.getByRole(
        'region',
        {
          name: 'New task',
          exact: true,
        },
      )
      await form.getByRole(
        'textbox',
        {
          name: 'Task title',
          exact: true,
        },
      ).fill('An unassigned idea')
      await form.getByRole(
        'textbox',
        {
          name: 'Your ask',
          exact: true,
        },
      ).fill('Investigate the parser')
      expect(await form.getByRole(
        'button',
        {
          name: 'Start worker',
          exact: true,
        },
      ).isDisabled()).toBe(true)
      await form.getByRole(
        'button',
        {
          name: 'Save task',
          exact: true,
        },
      ).click()
      const card = workspace.locator('.card.selected')
      const chat = card.locator('.worker-chat')
      await chat.waitFor()
      const pendingCard = await card.elementHandle()
      await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))
      expect(await card.count()).toBe(1)
      expect(prematureReads).toEqual([])
      releaseCreate!()
      releaseCreate = undefined
      await until({
        what: 'creation confirms without replacing the selected card',
        check: () => card.evaluate(({ dataset }) => dataset.task?.startsWith('task-')),
      })
      expect(await pendingCard!.evaluate(({ isConnected }) => isConnected)).toBe(true)
      await chat.getByRole(
        'textbox',
        {
          name: 'Message worker',
          exact: true,
        },
      ).fill('Start the existing idea')
      expect(await chat.getByRole(
        'button',
        {
          name: 'Send to worker',
          exact: true,
        },
      ).isDisabled()).toBe(true)
      await chat.getByRole(
        'combobox',
        {
          name: 'Repository',
          exact: true,
        },
      ).click()
      await chat.getByRole(
        'option',
        {
          name: 'card-repository',
          exact: true,
        },
      ).click()
      await until({
        what: 'repository assignment enables Send',
        check: async () => await chat.getByRole(
          'button',
          {
            name: 'Send to worker',
            exact: true,
          },
        ).count() === 1
          && await chat.getByRole(
            'button',
            {
              name: 'Send to worker',
              exact: true,
            },
          ).isEnabled(),
      })
      expect(await chat.getByRole(
        'textbox',
        {
          name: 'Message worker',
          exact: true,
        },
      ).inputValue()).toBe('Start the existing idea')
      await chat.getByRole(
        'button',
        {
          name: 'Send to worker',
          exact: true,
        },
      ).click()
      await until({
        what: 'the existing idea has a worker in its copy',
        check: () => pnyx.claude.sessions.some(session => session.received.some(text => text.includes('Start the existing idea'))),
      })
      const first = pnyx.claude.sessions.find(session => session.received.some(text => text.includes('Start the existing idea')))!
      expect(first.cwd).not.toBe(repository)
      expect(await card.locator('xpath=ancestor::section[contains(@class,"project-column")]').getAttribute('data-column')).toBe(repository)
      await workspace.getByRole(
        'button',
        {
          name: 'New task in Ideas',
          exact: true,
        },
      ).click()
      await form.getByRole(
        'textbox',
        {
          name: 'Task title',
          exact: true,
        },
      ).fill('A new quick task')
      await form.getByRole(
        'textbox',
        {
          name: 'Your ask',
          exact: true,
        },
      ).fill('Start from the creation composer')
      await form.getByRole(
        'combobox',
        {
          name: 'Repository',
          exact: true,
        },
      ).click()
      await form.getByRole(
        'option',
        {
          name: 'card-repository',
          exact: true,
        },
      ).click()
      await form.getByRole(
        'button',
        {
          name: 'Start worker',
          exact: true,
        },
      ).click()
      await until({
        what: 'the second creation is held',
        check: () => releaseCreate,
      })
      const pendingProject = workspace.getByRole(
        'button',
        {
          name: 'A new quick task',
          exact: true,
        },
      )
        .locator('xpath=ancestor::section[@data-column][1]')
      expect(await pendingProject.getAttribute('data-column')).toBe(repository)
      expect(prematureReads).toEqual([])
      const pendingQuickTask = await pendingProject.locator('.card.selected').elementHandle()
      releaseCreate!()
      await until({
        what: 'the creation composer starts another worker',
        check: () => pnyx.claude.sessions.some(session => session.received.some(text => text.includes('Start from the creation composer'))),
      })
      const next = pnyx.claude.sessions.find(session => session.received.some(text => text.includes('Start from the creation composer')))!
      expect(await pendingQuickTask!.evaluate(({ isConnected }) => isConnected)).toBe(true)
      expect(next.cwd).not.toBe(first.cwd)
      expect(next.cwd).not.toBe(repository)
      expect((await hydra.owner({
        args: [
          'hydra',
          'messages',
        ],
      })).messages).toBe('none: no messages after seq 0')
    } finally {
      await page.context().close()
    }
  },
)

test(
  'outside worker controls stay disabled until Continue in Pnyx',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'outside-card' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'outside',
        '--title',
        'Outside worker',
        '--folder',
        folder,
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
        agent: {
          provider: 'claude-code',
          sessionId: 'outside-session',
          cwd: folder,
        },
        activity: 'ended',
        terminal: { tty: '/dev/ttys009' },
      }),
    })
    await hydra.owner({
      args: [
        'task',
        'attach',
        'outside',
        '--session',
        'claude-code:outside-session',
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const workspace = page.locator(`[data-hydra-workspace="${hydra.id}"]`)
      await workspace.getByRole(
        'button',
        {
          name: 'Outside worker',
          exact: true,
        },
      ).click()
      const controls = workspace.locator('.worker-chat .hydra-agent-pickers button:visible')
      await controls.first().waitFor()
      // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
      expect(await controls.evaluateAll(elements => elements.every(element =>
        (element as HTMLButtonElement).disabled))).toBe(true)
      await hydra.owner({
        args: [
          'task',
          'continue',
          'outside',
        ],
      })
      await until({
        what: 'Continue enables the shared worker controls',
        // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
        check: () => controls.evaluateAll(elements => elements.length > 0
        && elements.every(element => !(element as HTMLButtonElement).disabled)),
      })
    } finally {
      await page.context().close()
    }
  },
)
