import { hydraSdk } from './hydra-host-fixture.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { project } from '../src/projects/cli.ts'
import { startServer } from '../src/server/server.ts'
import { HYDRA_CARD, hydraEvent } from '../src/core/hydra.ts'
import { decidePush } from '../src/core/decide.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = realpathSync(mkdtempSync(join(
  tmpdir(),
  'pnyx-project-smoke-',
)))
process.env.PNYX_HOME = join(
  home,
  'pnyx',
)
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
const folder = join(
  home,
  'sample-project',
)
const source = join(
  home,
  'source',
)
const into = join(
  home,
  'cloned-project',
)
const recent = join(
  home,
  'recent-project',
)
const parent = join(
  home,
  'repos',
)
mkdirSync(folder)
mkdirSync(source)
mkdirSync(recent)
mkdirSync(into)
mkdirSync(parent)
mkdirSync(join(
  parent,
  'existing',
))
commands.hydra([
  'create',
  'default',
  '--name',
  'Work',
])
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const decision = decidePush({
      state: writer.state,
      newCardId: 'recent-session',
      key: 'recent',
      input: {
        agent: {
          provider: 'claude-code',
          sessionId: 'recent',
          cwd: recent,
        },
      },
      meta: {
        actor: 'fixture',
        at: '2026-10-15T12:00:00Z',
      },
    })
    assert.ok('event' in decision); writer.append({ event: decision.event })
  },
})
execFileSync(
  'git',
  [
    'init',
    '--bare',
    source,
  ],
  { stdio: 'ignore' },
)
commands.hydra([
  'create',
  'other',
  '--name',
  'Other Hydra',
])
await project([
  'add',
  folder,
  '--hydra',
  'other',
])
commands.hydra([
  'create',
  'third',
  '--name',
  'Third Hydra',
])
const shared = await project([
  'add',
  folder,
  '--hydra',
  'third',
])
await project([
  'add',
  folder,
  '--hydra',
  'third',
  '--confirm',
  String(shared.token),
])
let server = await startServer({
  query: hydraSdk().query,
  hydraId: 'default',
  port: 0,
})
const {
  browser,
  eventually,
  text,
  fill,
  click,
  screenshot,
  evaluate,
  press,
  focus,
  check,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-projects',
})

try {
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await browser({
    args: [
      'resize',
      '1440',
      '1100',
    ],
  })
  await browser({
    args: [
      'wait',
      'Settings',
    ],
  })
  await eventually({
    condition: '!!document.querySelector(".hydra-project-setup")',
    label: 'empty Hydra offers projects where its chat will appear',
  })
  await screenshot({ name: 'projects-empty.png' })
  await text({ label: 'Add a folder' })
  await eventually({
    condition: '!!document.querySelector(".recent-folders button")',
    label: 'History folders available in one click',
  })
  await check({
    condition: `document.querySelector('.recent-folders button').title === ${JSON.stringify(recent)}`,
    label: 'History includes an unattached agent folder',
  })
  await fill({
    label: 'Folder path',
    value: join(
      home,
      'sample',
    ),
  })
  await focus({ selector: '[aria-label="Folder path"]' })
  await eventually({
    condition: 'document.querySelector(".folder-options")?.textContent.includes("sample-project")',
    label: 'typed paths complete from disk',
  })
  await check({
    condition: 'getComputedStyle(document.querySelector(".folder-options")).position === "absolute"',
    label: 'suggestions float over content',
  })
  await screenshot({ name: 'projects-folders.png' })
  await press({ key: 'Escape' })
  await check({
    condition: '!document.querySelector(".folder-options")',
    label: 'Escape closes folder suggestions',
  })
  await press({ key: 'ArrowDown' }); await press({ key: 'Enter' })
  await eventually({
    condition: `document.querySelector('[aria-label="Folder path"]').value === ${JSON.stringify(folder)} && !document.querySelector('.folder-options')`,
    label: 'keyboard selects a folder',
  })
  await click({ selector: '.project-form button[type=submit]' })
  await eventually({
    condition: '!!document.querySelector(".project-sharing")',
    label: 'sharing asks inline',
  })
  await check({
    condition: 'document.querySelectorAll(".project-sharing a").length === 2 && [...document.querySelectorAll(".project-sharing a")].every(a => a.target === "_blank") && document.querySelector(".project-sharing").textContent.includes("Other Hydra") && document.querySelector(".project-sharing").textContent.includes("Third Hydra") && !document.querySelector("dialog")',
    label: 'sharing names every Hydra with new-tab links',
  })
  await evaluate({ code: 'const links = [...document.querySelectorAll(\'.project-sharing a\')]; for (const a of links) { const response = await fetch(a.href); const html = await response.text(); if (response.url !== a.href || !html.includes(\'<base href="\' + new URL(a.href).pathname + \'"\')) throw new Error(\'Sharing link did not open the selected Hydra\'); } return true;' })
  assert.equal(
    loadHydra({ hydraId: 'default' }).state.projects,
    undefined,
  )
  await screenshot({ name: 'projects-confirmation.png' })
  await text({ label: 'Cancel' })
  assert.equal(
    loadHydra({ hydraId: 'default' }).state.projects,
    undefined,
  )
  await click({ selector: '.project-form button[type=submit]' })
  await eventually({
    condition: '!!document.querySelector(".project-sharing")',
    label: 'sharing can be requested again',
  })
  await text({ label: 'Add anyway' })
  await eventually({
    condition: '!document.querySelector(".hydra-project-setup") && !!document.querySelector(".hydra-chat")',
    label: 'first attached project folds setup into Hydra chat',
  })
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        meta: {
          actor: 'fixture',
          at: '2026-10-15T13:00:00Z',
        },
        cardId: HYDRA_CARD,
        change: {
          type: 'hydra.message',
          data: {
            action: 'send',
            text: 'Earlier conversation.\n\n'.repeat(80),
            hydra: 'hydra',
          },
        },
      })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  await eventually({
    condition: 'document.querySelector(".hydra-messages").scrollHeight > document.querySelector(".hydra-messages").clientHeight',
    label: 'long Hydra conversation is scrollable',
  })
  await evaluate({ code: 'const stream = document.querySelector(".hydra-messages"); stream.scrollTop = stream.scrollHeight; return true;' })
  await text({ label: 'Add project' })
  await eventually({
    condition: '!!document.querySelector(".hydra-project-setup")',
    label: 'panel Add project opens the same actions',
  })
  await check({
    condition: 'document.activeElement === document.querySelector(".add-project-box h2") && document.querySelector(".add-project-box h2").getBoundingClientRect().top >= document.querySelector(".hydra-messages").getBoundingClientRect().top',
    label: 'Add project scrolls into view and receives focus above a long transcript',
  })
  await text({ label: 'Add a folder' })
  await eventually({
    condition: '!!document.querySelector(".recent-folders button")',
    label: 'recent folders shown again',
  })
  await click({ selector: '.recent-folders button' })
  await eventually({
    condition: '!document.querySelector(".hydra-project-setup")',
    label: 'History folder attaches in one click',
  })
  await text({ label: 'Add project' })
  await text({ label: 'Clone a repo' })
  await fill({
    label: 'Repository to clone',
    value: source,
  })
  await fill({
    label: 'Destination',
    value: into,
  })
  await eventually({
    condition: `document.querySelector('.clone-preview strong')?.textContent === ${JSON.stringify(into)}`,
    label: 'empty destination clones into that folder',
  })
  await check({
    condition: `document.querySelector('.picked-folder strong').textContent === 'cloned-project' && document.querySelector('.picked-folder small').textContent === ${JSON.stringify(into)}`,
    label: 'destination shows folder name and path',
  })
  await focus({ selector: '[aria-label="Destination"]' }); await press({ key: 'Escape' })
  await screenshot({ name: 'projects-clone.png' })
  await text({ label: 'Clone and attach' })
  await eventually({
    condition: '!document.querySelector(".hydra-project-setup")',
    label: 'clone attaches and folds setup away',
  })
  assert.ok(existsSync(join(
    into,
    '.git',
  )))
  await text({ label: 'Add project' })
  await text({ label: 'Clone a repo' })
  await fill({
    label: 'Repository to clone',
    value: source,
  })
  await fill({
    label: 'Destination',
    value: parent,
  })
  await eventually({
    condition: `document.querySelector('.clone-preview strong')?.textContent === ${JSON.stringify(join(
      parent,
      'source',
    ))}`,
    label: 'parent destination previews a repo-named child',
  })
  await focus({ selector: '[aria-label="Destination"]' }); await press({ key: 'Escape' })
  await screenshot({ name: 'projects-clone-parent.png' })
  await text({ label: 'Clone and attach' })
  await eventually({
    condition: '!document.querySelector(".hydra-project-setup")',
    label: 'parent clone attaches',
  })
  assert.ok(existsSync(join(
    parent,
    'source',
    '.git',
  )))
  assert.equal(
    loadHydra({ hydraId: 'default' }).state.projects?.length,
    4,
  )
  await text({ label: 'Settings' })
  await eventually({
    condition: '!!document.querySelector(\'[aria-label="Detach sample-project"]\')',
    label: 'attached projects shown in Settings',
  })
  await click({ selector: '[aria-label="Detach sample-project"]' })
  await eventually({
    condition: '!!document.querySelector(\'.project-row.detached [aria-label="Re-attach sample-project"]\')',
    label: 'detached project stays available',
  })
  await screenshot({ name: 'projects-detached.png' })
  await click({ selector: '[aria-label="Re-attach sample-project"]' })
  await eventually({
    condition: '!!document.querySelector(".project-sharing")',
    label: 're-attachment confirms sharing inline',
  })
  await text({ label: 'Add anyway' })
  await eventually({
    condition: '!!document.querySelector(\'[aria-label="Detach sample-project"]\')',
    label: 'project re-attached',
  })
  await screenshot({ name: 'projects-attached.png' })
  commands.task([
    'create',
    '--title',
    'Work in sample project',
    '--key',
    'sample-work',
    '--project',
    folder,
  ])
  await click({ selector: '[data-hydra-current]' })
  await eventually({
    condition: 'document.querySelector(\'.project-label\')?.textContent === \'sample-project\'',
    label: 'cards show the project folder name',
  })
  await text({ label: 'Settings' })
  await evaluate({ code: 'location.reload(); return true;' })
  await browser({
    args: [
      'wait',
      'Settings',
    ],
  })
  await text({ label: 'Settings' })
  await eventually({
    condition: '!!document.querySelector(\'[aria-label="Detach cloned-project"]\')',
    label: 'project list survives reload',
  })
  await fill({
    label: 'Start command name for sample-project',
    value: 'Local worker',
  })
  await fill({
    label: 'Start command for sample-project',
    value: 'echo fixture',
  })
  await click({ selector: 'form[aria-label="Start settings for sample-project"] [role=switch]' })
  await click({ selector: 'form[aria-label="Start settings for sample-project"] button[type=submit]' })
  await eventually({
    condition: '[...document.querySelectorAll("[role=status]")].some(el => el.textContent.trim() === "Project start command saved.")',
    label: 'project start command saved',
  })
  assert.deepEqual(
    loadHydra({ hydraId: 'default' }).state.projects?.find(p => p.path === folder)?.startCommand,
    {
      name: 'Local worker',
      command: 'echo fixture',
      bringsOwnFolder: true,
    },
  )
  await evaluate({ code: 'document.querySelector("[aria-label=Projects]").scrollIntoView(); return true;' })
  await screenshot({ name: 'project-command-after.png' })
  const port = server.port
  await server.close(); server = await startServer({
    query: hydraSdk().query,
    hydraId: 'default',
    port,
  })
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await browser({
    args: [
      'wait',
      'Settings',
    ],
  })
  await text({ label: 'Settings' })
  await eventually({
    condition: 'document.querySelectorAll(\'.project-row [aria-label^=Detach]\').length === 4',
    label: 'projects survive a server restart',
  })
  await eventually({
    condition: 'document.querySelector(\'[aria-label="Start command name for sample-project"]\')?.value === "Local worker"',
    label: 'command settings survive reload and server restart',
  })
  const nativeHome = join(
    home,
    'firstmate',
  )
  mkdirSync(
    join(
      nativeHome,
      'state',
    ),
    { recursive: true },
  )
  mkdirSync(join(
    nativeHome,
    'projects',
  ))
  symlinkSync(
    folder,
    join(
      nativeHome,
      'projects',
      'sample',
    ),
  )
  commands.hydra([
    'set',
    '--firstmate',
    nativeHome,
  ])
  await eventually({
    condition: 'document.querySelector(\'[aria-label=Projects]\')?.textContent.includes(\'Managed by Firstmate\') && !document.querySelector(\'[aria-label=Projects] form\') && document.querySelectorAll(\'.project-row\').length === 1',
    label: 'Firstmate projects are read-only',
  })
  symlinkSync(
    into,
    join(
      nativeHome,
      'projects',
      'cloned',
    ),
  )
  await text({ label: 'Refresh projects' })
  await eventually({
    condition: 'document.querySelectorAll(\'.project-row\').length === 2',
    label: 'Firstmate project refresh reads external changes',
  })
  await screenshot({ name: 'projects-firstmate.png' })
  process.stdout.write('Projects browser smoke passed.\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ persistedProjects: loadHydra({ hydraId: 'default' }).state.projects }) + '\n')
  process.stdout.write(await evaluate({ code: 'return { url: location.href, seq: document.querySelector(\'.app\')?.dataset.seq, projects: document.querySelector(\'[aria-label=Projects]\')?.textContent, notice: document.querySelector(\'.notice\')?.textContent };' }))
  await screenshot({ name: 'projects-reload-diagnostic.png' })
  throw error
} finally {
  await server.close(); await close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
