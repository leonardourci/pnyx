import { hydraSdk } from './hydra-host-fixture.ts'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'
import { seedWebFixture } from './web-fixture.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-resize-',
))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
const fixture = seedWebFixture({ home })
appendFileSync(
  fixture.transcript,
  Array.from(
    { length: 12 },
    (
      _,
      i,
    ) => JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        content: [
          {
            type: 'text',
            text: `Update ${i}: ` + 'The worker is checking the migration and its rollback path. '.repeat(8),
          },
        ],
      },
    }),
  ).join('\n') + '\n',
)
const server = await startServer({
  query: hydraSdk().query,
  hydraId: 'default',
  homes: [fixture.nativeHome],
})
const {
  browser,
  evaluate,
  check,
  eventually,
  click,
  drag,
  focus,
  press,
  screenshot,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-resize',
})
const state = () => loadHydra({ hydraId: 'default' }).state
const card = `[data-card="${fixture.state.keys.layout}"]`

try {
  await browser({
    args: [
      'open',
      server.url,
    ],
  }); await browser({
    args: [
      'resize',
      '1800',
      '1000',
    ],
  })
  await eventually({
    condition: '!!document.querySelector(".hydra-chat .composer")',
    label: 'Hydra composer appears',
  })
  await check({
    condition: '!document.querySelector(".composer .resize-y")',
    label: 'the composer has no drag handle; it grows with its draft',
  })
  await click({ selector: card })
  await eventually({
    condition: '!!document.querySelector(".task-updates")',
    label: 'task opens Updates',
  })
  await check({
    condition: 'document.querySelectorAll(".detail .task-conversation .composer").length === 1',
    label: 'attached task has its own conversation and composer',
  })
  await check({
    condition: 'Number(getComputedStyle(document.querySelector(".card.selected > .resize-y"), "::after").opacity) >= .5',
    label: 'open card exposes a visible resize grip',
  })
  await drag({
    selector: '.card.selected > [aria-label="Resize card"]',
    dy: 100,
  })
  await eventually({
    condition: 'document.querySelector(".card.selected").clientHeight === 578',
    label: 'mouse drag grows the open card to 580 px',
  })
  assert.equal(
    state().view?.cardHeights[fixture.state.keys.layout!],
    580,
  )
  await check({
    condition: 'document.querySelector(".task-updates").getBoundingClientRect().bottom < document.querySelector(".card.selected").getBoundingClientRect().bottom',
    label: 'resized card contains Updates',
  })
  await screenshot({ name: 'resized-composers-card.png' })
  await click({ selector: '[aria-label="Close detail"]' })
  await check({
    condition: `document.querySelector(${JSON.stringify(card)}).closest('.card').getBoundingClientRect().height === 176 && !document.querySelector('.card > [aria-label="Resize card"]')`,
    label: 'closed cards keep their fixed size',
  })
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await eventually({
    condition: '!!document.querySelector(".hydra-chat .composer")',
    label: 'Hydra composer appears after reload',
  })
  await click({ selector: card })
  await eventually({
    condition: 'document.querySelector(".card.selected")?.getBoundingClientRect().height === 580',
    label: 'card height survives reload',
  })
  await focus({ selector: '.card.selected > [aria-label="Resize card"]' })
  await press({ key: 'Home' })
  await check({
    condition: 'document.querySelector(".task-updates").clientHeight >= 80',
    label: 'minimum card height retains readable Updates',
  })
  await focus({ selector: '[aria-label="Close detail"]' })
  await press({ key: 'PageDown' })
  await eventually({
    condition: 'document.querySelector(".detail").scrollTop > 0',
    label: 'minimum card height lets the owner scroll through the task conversation',
  })
  await press({ key: 'End' })
  await eventually({
    condition: '(() => { const composer = document.querySelector(".detail .composer").getBoundingClientRect(); const detail = document.querySelector(".detail").getBoundingClientRect(); return composer.top >= detail.top && composer.bottom <= detail.bottom; })()',
    label: 'native scrolling reaches the task composer at minimum card height',
  })
  await screenshot({ name: 'minimum-card-composer.png' })
  await evaluate({ code: 'document.querySelector(".task-updates").scrollIntoView({ block: "start" }); return true;' })
  await focus({ selector: '.card.selected > [aria-label="Resize card"]' })
  await press({ key: 'End' })
  await browser({
    args: [
      'resize',
      '1440',
      '400',
    ],
  })
  await check({
    condition: 'document.querySelector(".card.selected").getBoundingClientRect().height <= document.querySelector(".column-cards").clientHeight && document.querySelector(".task-updates").getBoundingClientRect().bottom <= document.querySelector(".card.selected").getBoundingClientRect().bottom',
    label: 'short panes cap the resized card and contain Updates',
  })
  process.stdout.write('Composer and card drag resize browser smoke passed.\n')
} finally {
  await close(); await server.close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
