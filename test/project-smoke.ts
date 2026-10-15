import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { project } from '../src/projects/cli.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = realpathSync(mkdtempSync(join(tmpdir(), 'pnyx-project-smoke-')))
process.env.PNYX_HOME = join(home, 'pnyx')
const folder = join(home, 'sample-project'), source = join(home, 'source'), into = join(home, 'cloned-project')
mkdirSync(folder); mkdirSync(source)
execFileSync('git', ['init', '--bare', source], { stdio: 'ignore' })
commands.hydra(['create', 'other', '--name', 'Other Hydra'])
await project(['add', folder, '--hydra', 'other'])
let server = await startServer({ hydraId: 'default', port: 0 })
const { browser, eventually, text, fill, click, screenshot, evaluate, close } = smokeBrowser({ home, session: 'pnyx-projects' })

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['resize', '1440', '1100'] })
  await browser({ args: ['wait', 'Settings'] })
  await text({ label: 'Settings' })
  await eventually({ condition: '!!document.querySelector("[aria-label=Projects] form")', label: 'Projects settings loaded' })
  await evaluate({ code: 'document.querySelector("[aria-label=Projects]").scrollIntoView(); return true;' })
  await screenshot({ name: 'projects-empty.png' })
  await fill({ label: 'Project folder path', value: folder })
  await text({ label: 'Add project' })
  await eventually({ condition: '!!document.querySelector("dialog[open]")', label: 'sharing asks explicitly' })
  await eventually({ condition: 'document.querySelector("dialog a")?.textContent === "Other Hydra" && document.querySelector("dialog a").getAttribute("href") === "/?open-hydra=other"', label: 'sharing names and links the other Hydra' })
  assert.equal(loadHydra({ hydraId: 'default' }).state.projects, undefined)
  await screenshot({ name: 'projects-confirmation.png' })
  await text({ label: 'Cancel' })
  assert.equal(loadHydra({ hydraId: 'default' }).state.projects, undefined)
  await text({ label: 'Add project' })
  await eventually({ condition: '!!document.querySelector("dialog[open]")', label: 'sharing can be requested again' })
  await text({ label: 'Attach project' })
  await eventually({ condition: '!!document.querySelector(\'[aria-label="Detach sample-project"]\') && !document.querySelector("dialog")', label: 'confirmed project attached' })
  await text({ label: 'Detach' })
  await eventually({ condition: '!!document.querySelector(\'.project-row.detached [aria-label="Re-attach sample-project"]\')', label: 'detached project stays greyed with re-attach' })
  await screenshot({ name: 'projects-detached.png' })
  await text({ label: 'Re-attach' })
  await eventually({ condition: '!!document.querySelector("dialog[open]")', label: 're-attachment also confirms sharing' })
  await text({ label: 'Attach project' })
  await eventually({ condition: '!!document.querySelector(\'[aria-label="Detach sample-project"]\')', label: 'project re-attached' })
  await fill({ label: 'Project clone URL', value: source })
  await fill({ label: 'Project clone destination', value: into })
  await text({ label: 'Clone and attach' })
  await eventually({ condition: '!!document.querySelector(\'[aria-label="Detach cloned-project"]\')', label: 'clone uses the chosen destination and attaches' })
  assert.equal(loadHydra({ hydraId: 'default' }).state.projects?.length, 2)
  await screenshot({ name: 'projects-attached.png' })
  commands.task(['create', '--title', 'Work in sample project', '--key', 'sample-work', '--project', folder])
  await click({ selector: '[aria-label="Switch Hydra"]' })
  await click({ selector: '[aria-current=page]' })
  await eventually({ condition: 'document.querySelector(\'.project-label\')?.textContent === \'sample-project\'', label: 'cards show the project folder name' })
  await text({ label: 'Settings' })
  await evaluate({ code: 'location.reload(); return true;' })
  await browser({ args: ['wait', 'Settings'] })
  await text({ label: 'Settings' })
  await eventually({ condition: '!!document.querySelector(\'[aria-label="Detach cloned-project"]\')', label: 'project list survives reload' })
  await fill({ label: 'Start command name for sample-project', value: 'Local worker' })
  await fill({ label: 'Start command for sample-project', value: 'echo fixture' })
  await click({ selector: 'form[aria-label="Start settings for sample-project"] [role=switch]' })
  await click({ selector: 'form[aria-label="Start settings for sample-project"] button[type=submit]' })
  await eventually({ condition: '[...document.querySelectorAll("[role=status]")].some(el => el.textContent.trim() === "Project start command saved.")', label: 'project start command saved' })
  assert.deepEqual(loadHydra({ hydraId: 'default' }).state.projects?.find(p => p.path === folder)?.startCommand, { name: 'Local worker', command: 'echo fixture', bringsOwnFolder: true })
  await evaluate({ code: 'document.querySelector("[aria-label=Projects]").scrollIntoView(); return true;' })
  await screenshot({ name: 'project-command-after.png' })
  const port = server.port
  await server.close(); server = await startServer({ hydraId: 'default', port })
  await browser({ args: ['open', server.url] })
  await browser({ args: ['wait', 'Settings'] })
  await text({ label: 'Settings' })
  await eventually({ condition: 'document.querySelectorAll(\'.project-row [aria-label^=Detach]\').length === 2', label: 'projects survive a server restart' })
  await eventually({ condition: 'document.querySelector(\'[aria-label="Start command name for sample-project"]\')?.value === "Local worker"', label: 'command settings survive reload and server restart' })
  const nativeHome = join(home, 'firstmate')
  mkdirSync(join(nativeHome, 'state'), { recursive: true })
  mkdirSync(join(nativeHome, 'projects'))
  symlinkSync(folder, join(nativeHome, 'projects', 'sample'))
  commands.hydra(['set', '--firstmate', nativeHome])
  await eventually({ condition: 'document.querySelector(\'[aria-label=Projects]\')?.textContent.includes(\'Managed by Firstmate\') && !document.querySelector(\'[aria-label=Projects] form\') && document.querySelectorAll(\'.project-row\').length === 1', label: 'Firstmate projects are read-only' })
  symlinkSync(into, join(nativeHome, 'projects', 'cloned'))
  await text({ label: 'Refresh projects' })
  await eventually({ condition: 'document.querySelectorAll(\'.project-row\').length === 2', label: 'Firstmate project refresh reads external changes' })
  await screenshot({ name: 'projects-firstmate.png' })
  process.stdout.write('Projects browser smoke passed.\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ persistedProjects: loadHydra({ hydraId: 'default' }).state.projects }) + '\n')
  process.stdout.write(await evaluate({ code: 'return { url: location.href, seq: document.querySelector(\'.app\')?.dataset.seq, projects: document.querySelector(\'[aria-label=Projects]\')?.textContent, notice: document.querySelector(\'.notice\')?.textContent };' }))
  await screenshot({ name: 'projects-reload-diagnostic.png' })
  throw error
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
