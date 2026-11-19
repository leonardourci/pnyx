import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { openHydra } from '../setup/browser.ts'
import { git } from '../setup/upgrade.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

test(
  'Ideas saves a title alone without a repository and both card composers start in the selected repository copy',
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

              if (frame.name === 'task' && frame.args?.[0] === 'create' && (frame.args?.includes('An unassigned idea') || frame.args?.includes('A new quick task'))) {
                releaseCreate = () => server.send(message)
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
      await page.reload()
      await form.getByRole(
        'textbox',
        {
          name: 'Task title',
          exact: true,
        },
      ).waitFor()
      expect(await form.getByRole(
        'textbox',
        {
          name: 'Task title',
          exact: true,
        },
      ).inputValue()).toBe('An unassigned idea')
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

test(
  'task modal keeps its address, traps and returns focus, and remembers chat-only across reload',
  async () => {
    const hydra = await pnyx.hydra()
    const repository = hydra.folder({ name: 'modal-project' })
    await hydra.owner({
      args: [
        'project',
        'add',
        repository,
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({
          workspace: {
            projectWidths: {
              ideas: 280,
              [repository]: 280,
            },
          },
        }),
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'modal',
        '--title',
        'Modal conversation',
        '--project',
        repository,
        '--brief',
        'Keep these instructions visible',
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const title = page.getByRole(
        'button',
        {
          name: 'Modal conversation',
          exact: true,
        },
      )
      expect(await title.getAttribute('aria-expanded')).toBe('false')
      const card = title.locator('xpath=ancestor::article[1]')
      await card.hover()
      const openModal = page.getByRole(
        'button',
        {
          name: 'Open modal',
          exact: true,
        },
      )
      // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
      const opening = openModal.evaluate(async trigger => {
        await new Promise<void>(resolve => trigger.addEventListener(
          'click',
          () => resolve(),
          { once: true },
        ))
        const widths: number[] = []
        let inlineFrames = 0

        for (let frame = 0; frame < 40; frame++) {
          await new Promise(requestAnimationFrame)
          const modal = document.querySelector('dialog.task-modal')

          if (!modal && document.querySelector('.hydra-workspace .card.selected .card-open-content')) {
            inlineFrames++
          }

          if (modal) {
            widths.push(modal.getBoundingClientRect().width)
          }
        }

        return {
          widths,
          inlineFrames,
        }
      })
      const closedWidth = (await card.boundingBox())!.width
      await openModal.click()
      const modal = page.getByRole(
        'dialog',
        {
          name: 'Modal conversation',
          exact: true,
        },
      )
      await modal.waitFor()
      expect(await modal.getByRole(
        'separator',
        {
          name: 'Resize card',
          exact: true,
        },
      ).count()).toBe(0)
      expect(await modal.getByRole(
        'button',
        {
          name: 'Modal conversation',
          exact: true,
        },
      ).count()).toBe(0)
      expect(await modal.getByRole(
        'heading',
        {
          name: 'Modal conversation',
          exact: true,
        },
      ).count()).toBe(1)
      const {
        widths,
        inlineFrames,
      } = await opening
      expect(inlineFrames).toBe(0)
      await until({
        what: 'modal opens at the standard share of the viewport',
        check: async () => {
          const box = await modal.boundingBox()

          return !!box && Math.abs(box.width - 1008) < 1 && Math.abs(box.height - 720) < 1
        },
      })
      expect(
        widths.some(width => width > closedWidth + 1 && width < 1007),
        JSON.stringify(widths),
      ).toBe(true)
      const behind = (await page.locator(`[data-hydra-workspace="${hydra.id}"] [data-column-heading]`).first()
        .boundingBox())!
      await page.mouse.move(
        behind.x + behind.width / 2,
        behind.y + behind.height / 2,
      )
      await page.mouse.down()
      await page.mouse.move(
        behind.x + behind.width / 2 + 80,
        behind.y + behind.height / 2,
        { steps: 12 },
      )
      const backgroundPickedUp = await page.locator('.physical-ghost').count()
      await page.mouse.up()
      expect(backgroundPickedUp).toBe(0)
      expect(await modal.count()).toBe(1)
      const passage = modal.getByText(
        'Keep these instructions visible',
        { exact: true },
      )
      // eslint-disable-next-line pnyx/object-params -- Playwright owns the element callback.
      const selection = await passage.evaluate(element => {
        const text = element.firstChild!
        const range = document.createRange()
        range.setStart(
          text,
          0,
        ); range.collapse(true)
        const start = range.getBoundingClientRect()
        range.setStart(
          text,
          4,
        ); range.collapse(true)
        const end = range.getBoundingClientRect()

        return {
          start: start.x,
          end: end.x,
          y: start.y + start.height / 2,
        }
      })
      await page.mouse.move(
        selection.start + 0.1,
        selection.y,
      )
      await page.mouse.down()
      await page.mouse.move(
        selection.end + 0.1,
        selection.y,
        { steps: 8 },
      )
      const textPickedUp = await page.locator('.physical-ghost').count()
      await page.mouse.up()
      expect(textPickedUp).toBe(0)
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Keep')

      const modalWidth = modal.getByRole(
        'separator',
        {
          name: 'Resize task modal width',
          exact: true,
        },
      )
      await modalWidth.focus()
      await page.keyboard.press('Home')
      await modal.getByRole(
        'separator',
        {
          name: 'Resize task modal height',
          exact: true,
        },
      ).focus()
      await page.keyboard.press('Home')
      await until({
        what: 'modal uses the chosen size',
        check: async () => {
          const box = await modal.boundingBox()

          return !!box && Math.abs(box.width - 560) < 1 && Math.abs(box.height - 440) < 1
        },
      })
      expect(new URL(page.url()).searchParams.get('task')).toBe((await hydra.task({ key: 'modal' })).id)
      await modal.getByRole(
        'button',
        {
          name: 'Focus on chat',
          exact: true,
        },
      ).click()
      expect(await modal.locator('.card-details').isVisible()).toBe(false)
      expect(await modal.getByRole('tab').count()).toBe(0)
      await modal.getByRole(
        'textbox',
        {
          name: 'Message worker',
          exact: true,
        },
      ).fill('Keep my unsent message')
      await page.keyboard.press('End')
      await modal.getByRole(
        'button',
        {
          name: 'Close',
          exact: true,
        },
      ).focus()
      await page.keyboard.press('Shift+Tab')
      // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
      expect(await modal.evaluate(element => element.contains(document.activeElement))).toBe(true)
      const closingFrom = (await modal.boundingBox())!.height
      const modalTask = (await hydra.task({ key: 'modal' })).id
      const closing = page.evaluate(
        // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
        async task => {
          const heights: number[] = []

          for (let frame = 0; frame < 30; frame++) {
            await new Promise(requestAnimationFrame)
            const inline = document.querySelector(`.hydra-workspace .card[data-task="${CSS.escape(task)}"]:not(dialog *)`)

            if (inline) {
              heights.push(inline.getBoundingClientRect().height)
            }
          }

          return heights
        },
        modalTask,
      )
      await page.keyboard.press('Escape')
      await modal.waitFor({ state: 'detached' })
      const closingHeights = await closing
      expect(await title.getAttribute('aria-expanded')).toBe('false')
      const closingTo = closingHeights.at(-1)!
      expect(
        closingHeights.some(height => height > Math.min(
          closingFrom,
          closingTo,
        ) + 1
          && height < Math.max(
            closingFrom,
            closingTo,
          ) - 1),
        JSON.stringify(closingHeights),
      ).toBe(true)
      await until({
        what: 'focus returns to the inline task title',
        // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
        check: () => title.evaluate(element => element === document.activeElement),
      })
      expect(new URL(page.url()).searchParams.has('task')).toBe(false)
      await card.hover()
      const hoverBar = page.getByRole(
        'button',
        {
          name: 'Open modal',
          exact: true,
        },
      ).locator('xpath=ancestor::*[@popover][1]')
      await until({
        what: 'closing the modal restores the hover bar to its inline card',
        check: async () => {
          const bar = await hoverBar.boundingBox(), box = await card.boundingBox()

          return !!bar && !!box && bar.x >= box.x
            && bar.x + bar.width <= box.x + box.width + 1
            && Math.abs(bar.y + bar.height - box.y) < 30
        },
      })

      await page.goForward()
      await modal.waitFor()
      const direct = await page.context().newPage()
      await direct.goto(page.url())
      await direct.getByRole(
        'dialog',
        {
          name: 'Modal conversation',
          exact: true,
        },
      ).waitFor()
      expect(await direct.getByRole(
        'dialog',
        {
          name: 'Modal conversation',
          exact: true,
        },
      ).locator('.card-details')
        .isVisible()).toBe(false)
      const remembered = await direct.getByRole(
        'dialog',
        {
          name: 'Modal conversation',
          exact: true,
        },
      ).boundingBox()
      expect(remembered!.width).toBeCloseTo(
        560,
        2,
      )
      expect(remembered!.height).toBeCloseTo(
        440,
        2,
      )
      await direct.close()
      await page.reload()
      await modal.waitFor()
      expect(await modal.locator('.card-details').isVisible()).toBe(false)
      expect(await modal.getByRole(
        'textbox',
        {
          name: 'Message worker',
          exact: true,
        },
      ).inputValue()).toBe('Keep my unsent message')
      await modal.getByRole(
        'button',
        {
          name: 'Show task summary',
          exact: true,
        },
      ).click()
      expect(await modal.locator('.card-details').isVisible()).toBe(true)
      await page.mouse.click(
        2,
        2,
      )
      await modal.waitFor({ state: 'detached' })
      await until({
        what: 'outside close restores card focus',
        // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
        check: () => title.evaluate(element => element === document.activeElement),
      })
      await title.click()
      await card.getByRole(
        'button',
        {
          name: 'Focus on chat',
          exact: true,
        },
      ).click()
      expect(await card.locator('.card-details').isVisible()).toBe(false)
      await page.reload()
      await card.waitFor()
      expect(await card.locator('.card-details').isVisible()).toBe(false)
    } finally {
      await page.context().close()
    }
  },
)

test(
  'sending in a task modal keeps overlapping workspace cards behind it',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'layering' })
    await hydra.owner({
      args: [
        'project',
        'add',
        folder,
      ],
    })
    await hydra.owner({
      args: [
        'view',
        'set',
        '--json',
        JSON.stringify({ workspace: { projectWidths: { [folder]: 850 } } }),
      ],
    })

    for (let index = 0; index < 6; index++) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          `Background task ${index}`,
          '--folder',
          folder,
          '--project',
          folder,
        ],
      })
    }

    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'layering',
        '--title',
        'Task layering',
        '--folder',
        folder,
        '--project',
        folder,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'layering',
        '--in-place',
      ],
    })
    const worker = await hydra.agent({ cwd: folder })
    await until({
      what: 'worker settles',
      check: () => worker.answered === 1,
    })
    const task = await hydra.task({ key: 'layering' })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })

    try {
      const card = page.locator(`article[data-task="${task.id}"]`).first()
      await card.hover()
      await page.getByRole(
        'button',
        {
          name: 'Open modal',
          exact: true,
        },
      ).click()
      const modal = page.getByRole(
        'dialog',
        {
          name: 'Task layering',
          exact: true,
        },
      )
      await modal.waitFor()
      await until({
        what: 'modal finishes opening',
        // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
        check: () => modal.evaluate(element => getComputedStyle(element).transform === 'none'),
      })
      await hydra.owner({
        args: [
          'task',
          'brief',
          task.id,
          '--brief',
          'Instructions updated while the modal stays open',
        ],
      })
      await modal.getByText(
        'Instructions updated while the modal stays open',
        { exact: true },
      ).waitFor()
      const reply = 'Message handled'
      const partial = 'Message'
      const turn = pnyx.claude.plan({
        hydra: hydra.id,
        hold: true,
        partial,
        reply,
      })
      onTestFinished(() => turn.release())
      const message = 'Keep the modal above the workspace'
      await modal.getByRole(
        'textbox',
        {
          name: 'Message worker',
          exact: true,
        },
      ).fill(message)
      await modal.getByRole(
        'button',
        {
          name: 'Send to worker',
          exact: true,
        },
      ).click()
      await until({
        what: 'worker receives the modal message',
        check: () => worker.received.some(text => text.includes(message)),
      })
      await modal.getByText(
        partial,
        { exact: true },
      ).waitFor({ state: 'visible' })

      for (const status of [
        'Running',
        'Idle',
      ]) {
        if (status === 'Idle') {
          turn.release()
          await modal.getByText(
            reply,
            { exact: true },
          ).waitFor({ state: 'visible' })
        }

        await until({
          what: `worker is visibly ${status}`,
          check: async () => await modal.getByText(
            status,
            { exact: true },
          ).isVisible(),
        })

        // eslint-disable-next-line pnyx/object-params -- Playwright owns browser callbacks.
        const coverage = await modal.evaluate(element => {
          const bounds = element.getBoundingClientRect()
          const cardsAboveModal: string[] = []
          let overlapCount = 0

          for (const card of document.querySelectorAll('article[data-task]')) {
            if (element.contains(card)) {
              continue
            }

            const box = card.getBoundingClientRect()
            const left = Math.max(
              bounds.left,
              box.left,
              0,
            )
            const right = Math.min(
              bounds.right,
              box.right,
              window.innerWidth,
            )
            const top = Math.max(
              bounds.top,
              box.top,
              0,
            )
            const bottom = Math.min(
              bounds.bottom,
              box.bottom,
              window.innerHeight,
            )

            if (left >= right || top >= bottom) {
              continue
            }

            overlapCount++
            const hit = document.elementFromPoint(
              (left + right) / 2,
              (top + bottom) / 2,
            )

            if (!element.contains(hit)) {
              cardsAboveModal.push(card.textContent ?? '')
            }
          }

          return {
            overlapCount,
            cardsAboveModal,
          }
        })
        expect(coverage.overlapCount).toBeGreaterThan(0)
        expect(coverage.cardsAboveModal).toEqual([])
      }
    } finally {
      await page.context().close()
    }
  },
)
