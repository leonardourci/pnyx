import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { viewFor } from '../src/core/view.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(tmpdir(), 'pnyx-oracle-keyboard-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home })
const server = await startServer({ hydraId: 'default', port: 0, homes: [fixture.nativeHome] })
const { browser, evaluate, eventually, check, fill, press, focus, screenshot, close } = smokeBrowser({ home, session: 'pnyx-oracle-keyboard' })
const state = () => loadHydra({ hydraId: 'default' }).state
const initial = state()
const view = viewFor({ state: initial })

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '900'] })
  await eventually({ condition: 'document.querySelector(".app")?.dataset.connected === "true"', label: 'Hydra connected' })
  await focus({ selector: '[aria-label=Oracle]' })
  await screenshot({ name: 'oracle-search.png' })
  await press({ key: 'ArrowDown' })
  await check({ condition: 'document.activeElement.matches("[role=row][data-result-id=theme]") && !document.querySelector(".oracle-results [role=listbox]")', label: 'ArrowDown selects the Theme row without entering its combobox' })
  await press({ key: 'ArrowDown' })
  await check({ condition: 'document.activeElement.dataset.resultId === "fontSize" && !document.querySelector(".oracle-results [role=listbox]")', label: 'the next ArrowDown selects a number row without opening Theme' })
  await screenshot({ name: 'oracle-navigation.png' })
  await press({ key: 'ArrowUp' }); await press({ key: 'Enter' })
  await check({ condition: 'document.activeElement.matches("[role=combobox][aria-label=Theme]") && !document.querySelector(".oracle-results [role=listbox]")', label: 'Enter explicitly focuses the selected row control' })
  await press({ key: 'ArrowDown' })
  await check({ condition: '!!document.querySelector(".oracle-results [role=listbox]")', label: 'arrows belong to the combobox only after entering editing' })
  await press({ key: 'Escape' })
  await check({ condition: 'document.activeElement.dataset.resultId === "theme" && !document.querySelector(".oracle-results [role=listbox]")', label: 'Escape closes the control and restores row navigation' })
  await press({ key: 'Escape' })
  await check({ condition: 'document.activeElement.matches("[aria-label=Oracle]") && !!document.querySelector(".oracle-results")', label: 'a second Escape returns to search and keeps results open' })

  await evaluate({
    code: `
    const grid = document.querySelector('[role=grid][aria-label="Oracle results"]');
    const rows = [...grid.querySelectorAll('[data-result-id]')];
    if (rows.length < 20) throw new Error('Expected the full mixed settings and actions catalog');
    rows[0].focus();
    for (const [index, row] of rows.entries()) {
      if (document.activeElement !== row) throw new Error('Skipped row ' + row.dataset.resultId);
      if (!row.querySelector(':scope > [role=gridcell]')) throw new Error('Missing gridcell');
      const rect = row.getBoundingClientRect(), pane = grid.getBoundingClientRect();
      if (rect.top < pane.top - 1 || rect.bottom > pane.bottom + 1) throw new Error('Active row scrolled out of view');
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await new Promise(requestAnimationFrame);
      if (index === rows.length - 1 && document.activeElement !== row) throw new Error('Down passed the last result');
    }
    for (const row of rows.toReversed()) {
      if (document.activeElement !== row) throw new Error('Skipped reverse row ' + row.dataset.resultId);
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await new Promise(requestAnimationFrame);
    }
    if (document.activeElement !== rows[0]) throw new Error('Up passed the first result');
    if (grid.querySelector('[role=listbox]')) throw new Error('Navigation opened a setting');
    return rows.length;
  `,
  })
  assert.deepEqual(viewFor({ state: state() }), view)
  assert.equal(state().configRevision, initial.configRevision)
  assert.equal(state().viewRevision, initial.viewRevision)
  process.stdout.write('Passed: every result row, including disabled actions and nested settings, navigates both ways without writes\n')

  await press({ key: 'Escape' }); await fill({ label: 'Oracle', value: '> font size' })
  await press({ key: 'ArrowDown' }); await press({ key: 'Enter' })
  await check({ condition: 'document.activeElement.matches(".oracle-results button[aria-label^=Decrease]")', label: 'Enter reaches the first enabled control in a number row' })
  await press({ key: 'Tab' })
  await check({ condition: 'document.activeElement.matches(`.oracle-results input[aria-label="UI font size"]`)', label: 'Tab reaches another control in the editing row' })
  await press({ key: 'Escape' })
  await check({ condition: 'document.activeElement.dataset.resultId === "fontSize"', label: 'Escape leaves a text field for row navigation' })
  await press({ key: 'ArrowDown' }); await press({ key: 'Escape' })
  await fill({ label: 'Oracle', value: '> focus mode' }); await press({ key: 'ArrowDown' }); await press({ key: 'Enter' })
  await check({ condition: `document.activeElement.matches('[role=switch][aria-label="Focus mode"]') && document.activeElement.getAttribute('aria-checked') === '${view.focusMode}'`, label: 'entering a toggle does not change its value' })
  await press({ key: 'Escape' }); await press({ key: 'Escape' })
  assert.deepEqual(viewFor({ state: state() }), view)

  await fill({ label: 'Oracle', value: '> UI font size' }); await press({ key: 'ArrowDown' }); await press({ key: 'Enter' }); await press({ key: 'Tab' })
  await fill({ label: 'UI font size', value: String(view.fontSize + 1) }); await press({ key: 'Enter' })
  await check({ condition: 'document.activeElement.dataset.resultId === "fontSize" && !!document.querySelector(".oracle-results")', label: 'Enter commits a field and restores its row without closing Oracle' })
  assert.equal(viewFor({ state: state() }).fontSize, view.fontSize + 1)
  await press({ key: 'Escape' })

  await fill({ label: 'Oracle', value: '> theme' }); await press({ key: 'ArrowUp' })
  await check({ condition: 'document.activeElement === [...document.querySelectorAll("[data-result-id]")].at(-1)', label: 'ArrowUp from search selects the last filtered result' })
  await press({ key: 'Home' }); await press({ key: 'Enter' }); await press({ key: 'Enter' }); await press({ key: 'End' }); await press({ key: 'Enter' })
  await eventually({ condition: 'document.documentElement.dataset.theme === "dark"', label: 'an intentional combobox choice saves' })
  assert.equal(viewFor({ state: state() }).theme, 'dark')
  await press({ key: 'Escape' }); await press({ key: 'Escape' })

  await fill({ label: 'Oracle', value: '> rename queued column' }); await press({ key: 'ArrowDown' }); await press({ key: 'Enter' }); await press({ key: 'Enter' })
  await check({ condition: 'document.activeElement.matches(".oracle-results form input")', label: 'an inline edit can replace its trigger inside the grid' })
  await press({ key: 'Escape' })
  await check({ condition: 'document.activeElement.dataset.resultId === "rename:queued" && !document.querySelector(".oracle-results form")', label: 'Escape cancels the inline edit and restores its row' })
  await press({ key: 'Escape' })

  await fill({ label: 'Oracle', value: '> delete parked column' }); await press({ key: 'ArrowDown' }); await press({ key: 'Enter' }); await press({ key: 'Enter' })
  await check({ condition: '!!document.querySelector(".oracle-results .inline-confirm") && document.activeElement.matches(".inline-confirm-trigger")', label: 'a destructive confirmation opens with its trigger focused' })
  await press({ key: 'Escape' })
  await check({ condition: 'document.activeElement.dataset.resultId === "delete:parked" && !document.querySelector(".oracle-results .inline-confirm")', label: 'Escape dismisses the confirmation before returning to its row' })
  assert.equal(state().configRevision, initial.configRevision)
  await press({ key: 'Escape' })

  await fill({ label: 'Oracle', value: 'readable' })
  await eventually({ condition: '!!document.querySelector(`[data-result-id^="hit:"]`)', label: 'task search results arrived' })
  await press({ key: 'ArrowDown' })
  await check({ condition: 'document.activeElement.dataset.resultId.startsWith("hit:")', label: 'task results use the same row navigation' })
  await press({ key: 'End' }); await press({ key: 'Home' })
  await check({ condition: 'document.activeElement.dataset.resultId.startsWith("hit:")', label: 'Home and End navigate across tasks, history and settings' })
  await press({ key: 'ArrowDown' })
  await check({ condition: 'document.activeElement.dataset.resultId === "history"', label: 'history is also a navigable result' })
  await press({ key: 'Escape' }); await fill({ label: 'Oracle', value: '> zzzxxyy-no-result' }); await press({ key: 'ArrowDown' })
  await check({ condition: 'document.activeElement.matches("[aria-label=Oracle]") && document.querySelector(".oracle-results").textContent.includes("No matching settings")', label: 'no results leaves focus safely in search' })
  await press({ key: 'Escape' })
  await check({ condition: '!document.querySelector(".oracle-results") && document.querySelector("[aria-label=Oracle]").value === ""', label: 'Escape from search closes Oracle and clears the filter' })
  process.stdout.write('Oracle keyboard browser smoke passed.\n')
} catch (error) {
  await screenshot({ name: 'oracle-failure.png' })
  throw error
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
