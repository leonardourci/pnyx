import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()
type CommandFields = {
  name: HTMLInputElement
  shell: HTMLTextAreaElement
  own: Element
}

test(
  'project command fields reconcile external changes without replacing a local draft or form',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'commands' })
    await s.owner({
      args: [
        'project',
        'add',
        folder,
      ],
    })
    const set = ({
      name,
      command,
      own,
    }: {
      name: string
      command: string
      own: boolean
    }) => s.owner({
      args: [
        'project',
        'set',
        folder,
        '--command-name',
        name,
        '--command',
        command,
        '--brings-own-folder',
        String(own),
      ],
    })
    await set({
      name: 'Initial worker',
      command: '/usr/bin/true initial',
      own: false,
    })
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.click({ selector: '[aria-label="Oracle"]' })
    await page.type({ text: 'Projects' })
    await page.shows({
      what: 'the initial command form',
      check: () => {
        const name = document.querySelector<HTMLInputElement>('[aria-label="Start command name for commands"]')
        const shell = document.querySelector<HTMLTextAreaElement>('[aria-label="Start command for commands"]')
        const own = document.querySelector('[aria-label="Brings its own folder"]')

        if (name?.value !== 'Initial worker' || !shell || !own) {
          return false
        }

        (window as unknown as { commandFields: CommandFields }).commandFields = {
          name,
          shell,
          own,
        }

        return true
      },
    })
    await set({
      name: 'Remote worker',
      command: '/usr/bin/true remote',
      own: true,
    })
    await page.shows({
      what: 'all pristine command fields follow an external update in place',
      check: () => {
        const fields = (window as unknown as { commandFields: CommandFields }).commandFields

        return Object.values(fields).every(node => node.isConnected)
        && fields.name.value === 'Remote worker' && fields.shell.value === '/usr/bin/true remote'
        && fields.own.getAttribute('aria-checked') === 'true'
      },
    })
    await page.click({ selector: '[aria-label="Start command name for commands"]' })
    await page.shows({
      what: 'select command name',
      check: () => {
        document.querySelector<HTMLInputElement>('[aria-label="Start command name for commands"]')!.select()

        return true
      },
    })
    await page.type({ text: 'Local worker draft' })
    await set({
      name: 'Another remote worker',
      command: '/usr/bin/true latest',
      own: false,
    })
    await page.shows({
      what: 'local edits survive while untouched command fields advance',
      check: () => {
        const fields = (window as unknown as { commandFields: CommandFields }).commandFields

        return Object.values(fields).every(node => node.isConnected)
        && fields.name.value === 'Local worker draft' && fields.shell.value === '/usr/bin/true latest'
        && fields.own.getAttribute('aria-checked') === 'false'
      },
    })
    await page.click({
      selector: '[aria-label="Start settings for commands"] button',
      text: 'Save start command',
    })
    await page.shows({
      what: 'command save settled',
      check: () => !document.querySelector('[data-pending]'),
    })
    const saved = s.state().projects?.find(project => project.path === folder)?.startCommand
    assert.deepEqual(
      saved,
      {
        name: 'Local worker draft',
        command: '/usr/bin/true latest',
        bringsOwnFolder: false,
      },
    )
    await set({
      name: 'Fresh worker',
      command: '/usr/bin/true fresh',
      own: true,
    })
    await page.shows({
      what: 'saved fields are pristine for the next canonical update',
      check: () => {
        const fields = (window as unknown as { commandFields: CommandFields }).commandFields

        return Object.values(fields).every(node => node.isConnected)
        && fields.name.value === 'Fresh worker' && fields.shell.value === '/usr/bin/true fresh'
        && fields.own.getAttribute('aria-checked') === 'true'
      },
    })
    await page.close()
  },
)
