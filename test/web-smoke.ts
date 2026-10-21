import { hydraSdk } from './hydra-host-fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { DEFAULT_WIDTHS } from '../src/core/view.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-layout-smoke-',
))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
const fixture = seedWebFixture({ home })
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const decision = hydraEvent({
      state: writer.state,
      meta: {
        actor: 'fixture',
        at: '2026-10-15T10:00:00Z',
      },
      cardId: '$board',
      change: {
        type: 'hydra.message',
        data: {
          action: 'send',
          text: 'Review the layout after lunch.',
          hydra: 'hydra',
        },
      },
    })
    assert.ok('event' in decision); writer.append({ event: decision.event })
  },
})
const server = await startServer({
  query: hydraSdk().query,
  hydraId: 'default',
  homes: [fixture.nativeHome],
})
const {
  browser,
  check,
  eventually,
  click,
  text,
  fill,
  press,
  focus,
  screenshot,
  close,
  evaluate,
} = smokeBrowser({
  home,
  session: 'pnyx-layout',
})
const state = () => loadHydra({ hydraId: 'default' }).state

try {
  await browser({
    args: [
      'open',
      server.url,
    ],
  }); await browser({
    args: [
      'resize',
      '1440',
      '900',
    ],
  }); await browser({
    args: [
      'wait',
      'Needs you',
    ],
  })
  await check({
    condition: 'document.querySelectorAll("[data-card]").length === 6 && !document.querySelector(".toolbar,.keyboard-toolbar,.notice,.detail-tabs")',
    label: 'compact Hydra has no extra toolbar or overlays',
  })
  await check({
    condition: 'document.querySelector(".hydra-chat").getBoundingClientRect().height === document.querySelector(".column").getBoundingClientRect().height && document.querySelector(".hydra-head").textContent === "Hydra"',
    label: 'Hydra and columns fill the Hydra height',
  })
  await eventually({
    condition: '(() => { const card=document.querySelector(".card"),grip=card.querySelector(":scope > .resize-y"),title=card.querySelector(".card-open"),rect=card.getBoundingClientRect();return rect.height >= Number(grip.getAttribute("aria-valuemin")) && rect.height <= Number(grip.getAttribute("aria-valuemax")) && title.getBoundingClientRect().bottom <= rect.bottom && !!card.querySelector(".card-state") && getComputedStyle(grip).opacity === "1" && !card.querySelector(".setting-chip,.tags,.links");})()',
    label: 'closed cards contain their title and state within content bounds with a visible resize grip',
  })
  await check({
    condition: '!!document.querySelector(".last-message")',
    label: 'agent updates are visible by default',
  })
  await screenshot({ name: 'hydra.png' })
  await text({ label: 'Settings' }); await click({ selector: '[aria-label="Agent updates on cards"]' })
  await eventually({
    condition: 'document.querySelector(\'[aria-label="Agent updates on cards"]\').getAttribute(\'aria-checked\') === \'false\'',
    label: 'card setting saved',
  })
  await click({ selector: '[aria-label="Agent updates on cards"]' })
  await eventually({
    condition: 'document.querySelector(\'[aria-label="Agent updates on cards"]\').getAttribute(\'aria-checked\') === \'true\'',
    label: 'agent updates restored',
  })
  await click({ selector: '[data-hydra-current]' })
  await eventually({
    condition: '!!document.querySelector(".last-message")',
    label: 'agent update preference is respected',
  })
  await check({
    condition: '!!document.querySelector("[data-oracle-slot] input") && !document.querySelector(".hydra-list")',
    label: 'Hydra list returns to the Hydra',
  })
  await fill({
    label: 'Oracle',
    value: 'readable',
  })
  await eventually({
    condition: 'document.querySelectorAll("[data-card]").length === 1',
    label: 'search filters Hydra from transcript matches',
  })
  await fill({
    label: 'Oracle',
    value: 'lunch',
  })
  await eventually({
    condition: 'document.querySelector(".oracle-hit")?.textContent.includes("Hydra conversation") && document.querySelectorAll("[data-card]").length === 0',
    label: 'search includes the Hydra conversation',
  })
  await screenshot({ name: 'oracle.png' })
  await click({ selector: '.oracle-hit button' })
  await check({
    condition: 'document.activeElement.matches(".hydra-chat textarea")',
    label: 'Hydra search result focuses its composer',
  })
  await fill({
    label: 'Oracle',
    value: '> theme',
  })
  await check({
    condition: 'document.querySelectorAll("[data-card]").length === 6 && !document.querySelector(".oracle-hit") && !!document.querySelector(".oracle-results [aria-label=Theme]")',
    label: 'command search leaves the Hydra intact',
  })
  await click({ selector: '.oracle-results [aria-label="Theme"]' }); await click({ selector: '[role=listbox][aria-label=Theme] > [role=option]:nth-child(3)' })
  await eventually({
    condition: 'document.documentElement.dataset.theme === "dark" && !!document.querySelector(".oracle-results")',
    label: 'search changes settings in place',
  })
  await screenshot({ name: 'oracle-setting.png' })
  await click({ selector: '.oracle-results [aria-label="Theme"]' }); await click({ selector: '[role=listbox][aria-label=Theme] > [role=option]:first-child' })
  await focus({ selector: '[aria-label="Oracle"]' }); await press({ key: 'Escape' })
  await eventually({
    condition: 'document.querySelectorAll("[data-card]").length === 6',
    label: 'Escape restores unfiltered Hydra',
  })
  await evaluate({ code: 'window.columnWidth = document.querySelector(".column").getBoundingClientRect().width; return true;' })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` })
  await eventually({
    condition: '!!document.querySelector(".task-updates")',
    label: 'task opens Updates',
  })
  await check({
    condition: '!!document.querySelector(".card.selected > .detail") && document.querySelector(".column").getBoundingClientRect().width === window.columnWidth && !document.querySelector(".detail-tabs,.conversation-brief,.thread-controls")',
    label: 'card opens downward without changing the column width',
  })
  await check({
    condition: 'document.activeElement.matches(".task-updates") && document.querySelectorAll(".card.selected .card-agent").length === 1 && !document.querySelector(".detail .message.tool")',
    label: 'open card has one agent icon and Updates',
  })
  await screenshot({ name: 'card-open.png' })
  await click({ selector: '.card.selected .card-open' })
  await focus({ selector: '[aria-label="Resize Hydra panel"]' }); await press({ key: 'ArrowRight' })
  await eventually({
    condition: 'document.querySelector("[aria-label=\\"Resize Hydra panel\\"]").getAttribute("aria-valuenow") === "368"',
    label: 'Hydra resize is saved',
  })
  assert.equal(
    state().view?.hydraWidth,
    DEFAULT_WIDTHS.hydra + 8,
  )
  await focus({ selector: '[aria-label="Resize Needs you column"]' }); await press({ key: 'ArrowRight' })
  await eventually({
    condition: 'document.querySelector("[aria-label=\\"Resize Needs you column\\"]").getAttribute("aria-valuenow") === "298"',
    label: 'column resize saved',
  })
  await text({ label: 'Settings' })
  await check({
    condition: 'Math.abs(document.querySelector(".settings").getBoundingClientRect().left - (document.querySelector(".shell").getBoundingClientRect().left + (document.querySelector(".shell").getBoundingClientRect().width - document.querySelector(".settings").getBoundingClientRect().width) / 2)) < 2 && document.querySelectorAll(".settings-grid > .settings-box").length >= 5',
    label: 'settings uses one centered readable column',
  })
  await click({ selector: '[aria-label="Focus mode"]' })
  await eventually({
    condition: 'document.querySelector("[aria-label=\\"Focus mode\\"]").getAttribute("aria-checked") === "false"',
    label: 'Focus can be disabled separately',
  })
  const beforeReset = state().seq
  await text({ label: 'Reset widths to defaults' })
  await eventually({
    condition: 'document.querySelector(".app").dataset.seq === ' + JSON.stringify(String(beforeReset + 1)),
    label: 'width defaults restored',
  })
  assert.equal(
    state().view?.hydraWidth,
    DEFAULT_WIDTHS.hydra,
  )
  assert.equal(
    state().view?.columnWidths.needs_you ?? DEFAULT_WIDTHS.column,
    DEFAULT_WIDTHS.column,
  )
  await click({ selector: '[data-hydra-current]' })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` })
  await eventually({
    condition: '!!document.querySelector(".detail .task-updates") && !document.querySelector(".detail .composer")',
    label: 'an attached task shows Updates without a conversation',
  })
  await text({ label: 'Settings' }); await fill({
    label: 'Oracle',
    value: '> New column',
  }); await text({ label: 'New column' })
  await eventually({
    condition: '!!document.querySelector(".hydra-page") && document.activeElement.getAttribute("aria-label") === "Rename New column column"',
    label: 'search creates a column from Settings and focuses its title',
  })
  await press({ key: 'Escape' })
  await browser({
    args: [
      'emulate',
      '--color-scheme',
      'dark',
    ],
  }); await screenshot({ name: 'hydra-dark.png' })
  await browser({
    args: [
      'resize',
      '700',
      '800',
    ],
  })
  await check({
    condition: 'document.querySelector(".hydra-chat").getBoundingClientRect().height > 600 && document.querySelector(".kanban").scrollWidth > document.querySelector(".kanban").clientWidth',
    label: 'narrow windows keep Hydra docked with horizontal overflow',
  })
  process.stdout.write('Layout browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
