import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { decidePush, decideView } from '../src/core/decide.ts'
import { COLUMNS } from '../src/core/model.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'
import { seedWebFixture } from './web-fixture.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-visual-smoke-'))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
const fixture = seedWebFixture({ home })
appendFileSync(fixture.transcript, `${JSON.stringify({
  type: 'assistant',
  timestamp: '2026-10-16T10:00:00Z',
  message: { content: [{ type: 'text', text: 'Inline `ready`.\n\n```typescript\nconst ready = true\n```' }] },
})}\n`)
commands.task(['create', '--key', 'queue', '--title', 'Plan the next release', '--column', 'queued'])
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const meta = { actor: 'fixture', at: '2026-10-16T10:00:00Z' }

    for (const key of ['queue', 'layout', 'coverage', 'review', 'docs']) {
      const result = decidePush({
        state: writer.state, key, input: { project: 'payments-api', tags: ['release'] }, meta,
      })
      assert.ok('event' in result); writer.append({ event: result.event })
    }

    const result = decideView({
      state: writer.state,
      meta,
      patch: { hydraWidth: 240, columnWidths: Object.fromEntries(COLUMNS.map(id => [id, 240])) },
    })
    assert.ok('event' in result); writer.append({ event: result.event })
  },
})
const server = await startServer({ hydraId: 'default', homes: [fixture.nativeHome] })
const { browser, check, eventually, click, text, screenshot, close, evaluate } = smokeBrowser({ home, session: 'pnyx-visual' })

try {
  await browser({ args: ['open', server.url] })
  await browser({ args: ['resize', '1800', '1000'] })
  await browser({ args: ['wait', 'Plan the next release'] })
  await evaluate({ code: 'await document.fonts.ready; return true;' })

  for (const theme of ['light', 'dark']) {
    commands.view(['set', '--json', JSON.stringify({ theme })])
    await eventually({ condition: `document.documentElement.dataset.theme === '${theme}'`, label: `${theme} theme applied` })
    await screenshot({ name: `hydra-${theme}.png` })
    await check({ condition: '[\'queued\',\'in_progress\',\'needs_you\',\'parked\',\'done\'].every(id => { const column = document.querySelector(\'[data-column="\'+id+\'"]\'); const heading = column.querySelector(\'h2\'); return !!heading.querySelector(\'svg\') && heading.textContent.trim().length > 0 && getComputedStyle(column).backgroundColor !== getComputedStyle(document.documentElement).backgroundColor; })', label: `${theme} columns have tinted wells, text and state icons` })
    await check({ condition: 'new Set([...document.querySelectorAll(\'.column-header h2 .inline-title\')].map(el => getComputedStyle(el).color)).size === 5', label: `${theme} column headings have five distinct mineral colors` })
    await check({ condition: '[...document.querySelectorAll(\'.task-label\')].every(el => el.dataset.labelColor && getComputedStyle(el).borderTopStyle === \'solid\' && getComputedStyle(el).backgroundColor !== \'rgba(0, 0, 0, 0)\')', label: `${theme} project labels and tags have a saved color, fill and outline` })
  }

  await check({ condition: 'document.fonts.check(\'14px "GFS Neohellenic"\') && [...document.fonts].filter(f => f.family === \'GFS Neohellenic\' && f.status === \'loaded\').length > 0 && getComputedStyle(document.querySelector(\'.app\')).fontFamily.includes(\'GFS Neohellenic\')', label: 'bundled GFS Neohellenic is loaded for the interface' })
  await check({ condition: 'getComputedStyle(document.querySelector(\'.card-open\')).fontSize === \'14px\' && getComputedStyle(document.querySelector(\'.column-header h2 .inline-title\')).fontSize === \'18px\' && getComputedStyle(document.querySelector(\'.task-label\')).fontSize === \'12px\'', label: 'card titles, pane headings and metadata use the accepted size scale' })
  await check({ condition: 'getComputedStyle(document.querySelector(\'.hydra-head .hydra-icon\')).maskImage.includes(\'hydra-lorc.svg\') && document.querySelector(\'.brand img\').getAttribute(\'src\') === \'/favicon.svg\' && document.querySelectorAll(\'.left-panel nav > button svg\').length === 3', label: 'Hydra mask, existing Pnyx favicon and navigation icons identify the interface' })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` })
  await eventually({ condition: '!!document.querySelector(\'.detail .message .markdown\')', label: 'synthetic conversation appears' })
  await check({ condition: 'getComputedStyle(document.querySelector(\'.detail .message .markdown\')).fontSize === \'16px\' && getComputedStyle(document.querySelector(\'.detail .message .markdown\')).fontFamily.includes(\'GFS Neohellenic\') && getComputedStyle(document.querySelector(\'.detail .composer textarea\')).fontFamily.includes(\'GFS Neohellenic\')', label: 'conversation and draft use GFS Neohellenic at the chat size' })
  await check({ condition: '!!document.querySelector(\'.detail .code-block code\') && [...document.querySelectorAll(\'.detail .markdown code\')].length === 2 && [...document.querySelectorAll(\'.detail .markdown code\')].every(el => getComputedStyle(el).fontFamily.includes(\'JetBrains Mono\') && getComputedStyle(el).fontSize === \'13px\')', label: 'inline and fenced Markdown keep JetBrains Mono and the accepted code size' })
  await click({ selector: '[aria-label="Close detail"]' })
  await text({ label: 'Settings' })
  await click({ selector: '.about summary' })
  await evaluate({ code: 'document.querySelector(\'.about\').scrollIntoView(); return true;' })
  await check({ condition: 'document.querySelector(\'.about\').textContent.includes(\'Hydra by Lorc\') && document.querySelector(\'.about\').textContent.includes(\'CC BY 3.0\') && document.querySelector(\'.about a[href="/fonts/gfs-neohellenic/OFL.txt"]\') && document.querySelector(\'.about a[href="/licenses/tabler-icons.txt"]\')', label: 'Settings About exposes icon attribution and local font and icon licenses' })
  await evaluate({ code: 'for (const path of [\'/fonts/gfs-neohellenic/OFL.txt\', \'/licenses/tabler-icons.txt\', \'/icons/hydra-lorc.svg\']) { const response = await fetch(path); if (!response.ok || !(await response.text()).length) throw new Error(\'Missing asset \'+path); } return true;' })
  await screenshot({ name: 'license-notices.png' })
  commands.view(['set', '--json', JSON.stringify({ fontSize: 18, chatFontSize: 20, codeFontSize: 15 })])
  await eventually({ condition: 'getComputedStyle(document.querySelector(\'.app\')).fontSize === \'18px\'', label: 'saved font preference applies' })
  await click({ selector: '[data-hydra-current]' })
  await check({ condition: 'Math.abs(parseFloat(getComputedStyle(document.querySelector(\'.column-header h2 .inline-title\')).fontSize) - 18 * 9 / 7) < .01 && Math.abs(parseFloat(getComputedStyle(document.querySelector(\'.task-label\')).fontSize) - 18 * 6 / 7) < .01', label: 'pane headings and metadata follow the saved UI font preference' })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` })
  await eventually({ condition: 'document.querySelector(\'.detail .message .markdown\') && getComputedStyle(document.querySelector(\'.detail .message .markdown\')).fontSize === \'20px\'', label: 'saved chat font size applies independently' })
  await check({ condition: 'Math.abs(parseFloat(getComputedStyle(document.querySelector(\'.task-recipient\')).fontSize) - 18 * 6 / 7) < .01', label: 'task delivery metadata follows the saved UI font preference' })
  await check({ condition: '[...document.querySelectorAll(\'.detail .markdown code\')].length === 2 && [...document.querySelectorAll(\'.detail .markdown code\')].every(el => getComputedStyle(el).fontSize === \'15px\') && getComputedStyle(document.querySelector(\'.detail .code-block pre\')).fontSize === \'15px\'', label: 'inline and fenced code follow the independent saved code font size' })
  const colors = loadHydra({ hydraId: 'default' }).state.labelColors
  assert.ok(colors?.some(entry => entry.label === 'payments-api'))
  process.stdout.write('Visual system smoke passed.\n')
} finally {
  await close(); await server.close(); rmSync(home, { recursive: true, force: true })
}
