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
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
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
        ).isEnabled(),
      })
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
        what: 'the creation composer starts another worker',
        check: () => pnyx.claude.sessions.some(session => session.received.some(text => text.includes('Start from the creation composer'))),
      })
      const next = pnyx.claude.sessions.find(session => session.received.some(text => text.includes('Start from the creation composer')))!
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
