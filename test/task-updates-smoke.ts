import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { smokeBrowser } from './browser.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-updates-smoke-'))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
process.env.PNYX_SEMANTIC = 'off'
commands.hydra(['create', 'default'])
commands.task(['create', '--key', 'migration', '--title', 'Check the migration', '--brief', 'Review the rollback path.', '--column', 'in_progress'])
commands.task(['status', 'migration', 'working', '--note', 'Migration checks pass. Reviewing the rollback path.', '--actor', 'worker'])
commands.task(['status', 'migration', 'needs_you', '--note', 'Which canary should receive the migration first?', '--actor', 'worker'])
const server = await startServer({ hydraId: 'default', query: hydraSdk().query })
const b = smokeBrowser({ home, session: 'pnyx-updates' })

try {
  await b.browser({ args: ['open', server.url] })
  await b.browser({ args: ['resize', '1440', '900'] })
  await b.eventually({ condition: '!!document.querySelector(".card-open")', label: 'task appears' })
  await b.click({ selector: '.card-open' })
  await b.eventually({ condition: 'document.querySelector(".task-updates")?.textContent.includes("Created task")', label: 'Updates loads existing factual history' })
  await b.check({ condition: '!document.querySelector(".detail [role=tab], .detail .composer, .detail .thread")', label: 'open card contains Updates without tabs, conversation or composer' })
  await b.check({ condition: 'document.querySelector(".task-updates li").textContent.includes("Which canary") && document.querySelectorAll(".task-updates time").length >= 3', label: 'newest declaration shows state, note and time' })
  commands.task(['status', 'migration', 'paused', '--note', 'Waiting for the canary decision.', '--actor', 'worker'])
  await b.eventually({ condition: 'document.querySelector(".task-updates li")?.textContent.includes("Waiting for the canary decision")', label: 'worker declarations arrive without a refresh' })

  for (const [width, height, size] of [[1440, 900, 'desktop'], [390, 844, 'phone']] as const) {
    await b.browser({ args: ['emulate', '--viewport', `${width}x${height}x1${size === 'phone' ? ',mobile,touch' : ''}`] })

    if (size === 'phone') {
      await b.press({ key: process.platform === 'darwin' ? 'Meta+b' : 'Control+b' })
    }

    await b.evaluate({ code: 'document.querySelector(".card.selected").scrollIntoView({ block: "nearest", inline: "center" }); return true;' })

    for (const theme of ['light', 'dark']) {
      commands.view(['set', '--json', JSON.stringify({ theme })])
      await b.eventually({ condition: `document.documentElement.dataset.theme === '${theme}'`, label: `${theme} theme` })
      await b.check({ condition: '(() => { const stream = document.querySelector(".task-updates"); const card = document.querySelector(".card.selected"); return stream.clientHeight >= 150 && stream.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom && stream.scrollWidth <= stream.clientWidth; })()', label: `${size} ${theme} updates remain readable inside the card` })
      await b.screenshot({ name: `updates-${size}-${theme}.png` })
    }
  }

  assert.doesNotMatch(await b.browser({ args: ['console'] }), /TypeError|ReferenceError|Uncaught/)
  process.stdout.write('Task updates browser smoke passed.\n')
} catch (error) {
  writeFileSync(join(process.env.PNYX_EVIDENCE_DIR ?? home, 'updates-failure.txt'), await b.evaluate({ code: 'return document.documentElement.outerHTML;' }))
  await b.screenshot({ name: 'updates-failure.png' })
  throw error
} finally {
  await b.close(); await server.close(); rmSync(home, { recursive: true, force: true })
}
