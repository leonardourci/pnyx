import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server/server.ts'
import { commands } from '../src/cli/commands.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'
import { seedWebFixture } from './web-fixture.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

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
const originalTitle = fixture.state.cards[fixture.state.keys.layout!]!.title

for (let revision = 0; revision < 8; revision++) {
  await commands.task([
    'rename',
    fixture.state.keys.layout!,
    '--title',
    `Layout resize check ${revision}`,
  ])
}

await commands.task([
  'rename',
  fixture.state.keys.layout!,
  '--title',
  originalTitle,
])
const server = await startServer({
  hydraId: 'default',
  homes: [fixture.nativeHome],
  query: hydraSdk().query,
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
  settle,
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
    condition: '(() => { const grip = document.querySelector(".hydra-chat .composer > .resize-y"); const style = getComputedStyle(grip); return Number(getComputedStyle(grip, "::after").opacity) >= .5 && grip.clientHeight >= 24 && style.touchAction === "none"; })()',
    label: 'composer grip is visible with a touch-sized hit area',
  })
  await settle()
  await evaluate({ code: 'window.hydraDragHeight = document.querySelector(".hydra-chat .composer").clientHeight + 100; return true;' })
  await drag({
    selector: '.hydra-chat [aria-label="Resize composer"]',
    dy: -100,
  })
  await eventually({
    condition: 'document.querySelector(".hydra-chat .composer").clientHeight === window.hydraDragHeight',
    label: 'mouse drag grows the Hydra composer',
  })
  const hydraHeight = state().view?.composerHeight
  assert.ok(hydraHeight && hydraHeight >= 180)
  await settle()
  await eventually({
    condition:`(() => {const card=document.querySelector(${JSON.stringify(card)}).closest('.card'),grip=card.querySelector('.resize-y');return card.getBoundingClientRect().height>0 && Number(grip.getAttribute('aria-valuemin')) === Number(grip.getAttribute('aria-valuemax'));})()`,
    label:'the initial closed card fits all its content at one height',
  })
  await evaluate({code:`window.fitHeight=document.querySelector(${JSON.stringify(card)}).closest('.card').getBoundingClientRect().height;return true;`})
  await drag({
    selector:`[data-task="${fixture.state.keys.layout}"] > [aria-label="Resize card"]`,
    dy:60,
  })
  await check({
    condition:`document.querySelector(${JSON.stringify(card)}).closest('.card').getBoundingClientRect().height === window.fitHeight && !document.querySelector('.card.selected')`,
    label:'dragging a content-fit closed card changes nothing',
  })
  assert.equal(
    state().view?.closedCardHeights[fixture.state.keys.layout!],
    undefined,
  )
  await commands.task([
    'status',
    fixture.state.keys.layout!,
    'working',
    '--note',
    [
      'The worker is checking the migration and rollback path.',
      'The migration preserves existing data and reports every rejected write. '.repeat(4),
      'The canary checks both forward migration and rollback before rollout. '.repeat(4),
    ].join('\n\n'),
    '--actor',
    'worker',
    '--hydra',
    'default',
  ])
  await eventually({
    condition:`(() => {const card=document.querySelector(${JSON.stringify(card)}).closest('.card'),grip=card.querySelector('.resize-y');return card.querySelector('.last-message')?.textContent.includes('The worker is checking the migration') && Number(grip.getAttribute('aria-valuemax')) > Number(grip.getAttribute('aria-valuemin'))+60;})()`,
    label:'a real multiline worker declaration gives closed resizing room to grow',
  })
  await click({ selector: card })
  await eventually({
    condition: '!!document.querySelector(".task-updates")',
    label: 'task opens Updates',
  })
  await check({
    condition: '!document.querySelector(".detail .composer, .detail .thread")',
    label: 'task card has no conversation or composer',
  })
  await check({
    condition: 'Number(getComputedStyle(document.querySelector(".card.selected > .resize-y"), "::after").opacity) >= .5',
    label: 'open card exposes a visible resize grip',
  })
  await check({
    condition: [
      '(() => { const card = document.querySelector(".card.selected")',
      'const pane = card.closest(".column-cards"), style = getComputedStyle(pane)',
      'const inner = pane.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)',
      'const grip=card.querySelector(".resize-y")',
      'return card.getBoundingClientRect().height === Math.max(Number(grip.getAttribute("aria-valuemin")), Math.min(Number(grip.getAttribute("aria-valuemax")), Math.round(Math.floor(inner) / 2))) })()',
    ].join('; '),
    label: 'an open card starts at half its column within its content bounds',
  })
  await evaluate({ code: 'window.openHeight = document.querySelector(".card.selected").getBoundingClientRect().height; window.openTarget = Math.min(window.openHeight + 100, Number(document.querySelector(".card.selected > .resize-y").getAttribute("aria-valuemax"))); if(window.openTarget === window.openHeight) throw new Error("Fixture must leave room for a saved resize"); return true;' })
  await drag({
    selector: '.card.selected > [aria-label="Resize card"]',
    dy: 100,
  })
  await eventually({
    condition: 'document.querySelector(".card.selected").getBoundingClientRect().height === window.openTarget',
    label: 'mouse drag grows the open card within its content maximum',
  })
  const opened = state().view?.cardHeights[fixture.state.keys.layout!]
  assert.ok(opened)
  await check({
    condition: `document.querySelector(".card.selected").getBoundingClientRect().height === ${opened}`,
    label: 'the open height is saved',
  })
  await check({
    condition: 'document.querySelector(".task-updates").getBoundingClientRect().bottom < document.querySelector(".card.selected").getBoundingClientRect().bottom',
    label: 'resized card contains Updates',
  })
  await screenshot({ name: 'resized-composers-card.png' })
  await click({ selector: '.card.selected .card-open' })
  await eventually({
    condition: '!document.querySelector(".card.selected")',
    label: 'title closes the card before closed resizing',
  })
  await evaluate({ code: `const card=document.querySelector(${JSON.stringify(card)}).closest('.card'); const grip=card.querySelector('.resize-y'); window.closedTarget=Math.min(card.getBoundingClientRect().height+60,Number(grip.getAttribute('aria-valuemax'))); return true;` })
  await drag({
    selector: `[data-task="${fixture.state.keys.layout}"] > [aria-label="Resize card"]`,
    dy: 60,
  })
  await eventually({
    condition: `document.querySelector(${JSON.stringify(card)}).closest('.card').getBoundingClientRect().height === window.closedTarget`,
    label: 'mouse drag grows the closed card within its content maximum',
  })
  await check({
    condition: '!document.querySelector(".card.selected")',
    label: 'resizing a closed card does not open it',
  })
  await focus({ selector: `[data-task="${fixture.state.keys.layout}"] > [aria-label="Resize card"]` })
  await press({ key: 'Home' })
  await eventually({
    condition: `(() => {const card=document.querySelector(${JSON.stringify(card)}).closest('.card'); return card.getBoundingClientRect().height === Number(card.querySelector('.resize-y').getAttribute('aria-valuemin'));})()`,
    label: 'closed resizing retains its complete content minimum',
  })
  await press({ key: 'End' })
  await eventually({
    condition: `(() => {const card=document.querySelector(${JSON.stringify(card)}).closest('.card'); return card.getBoundingClientRect().height === Number(card.querySelector('.resize-y').getAttribute('aria-valuemax'));})()`,
    label: 'closed resizing stops at the complete content maximum',
  })
  const closed = state().view?.closedCardHeights[fixture.state.keys.layout!]
  assert.ok(closed)
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await eventually({
    condition: `document.querySelector(".hydra-chat .composer")?.clientHeight === ${hydraHeight}`,
    label: 'Hydra composer height survives reload',
  })
  await check({
    condition: `document.querySelector(${JSON.stringify(card)}).closest('.card').getBoundingClientRect().height === ${closed}`,
    label: 'closed card content height survives reload',
  })
  await click({ selector: card })
  await eventually({
    condition: `document.querySelector(".card.selected")?.getBoundingClientRect().height === ${opened}`,
    label: 'open card height survives reload',
  })
  await browser({
    args: [
      'resize',
      '1440',
      '400',
    ],
  })
  await check({
    condition: `(() => { const card = document.querySelector(".card.selected"); const pane = card.closest(".column-cards"); return card.getBoundingClientRect().height === ${opened} && pane.scrollHeight > pane.clientHeight; })()`,
    label: 'a short pane retains the saved open height while its column scrolls',
  })
  await browser({
    args: [
      'resize',
      '1800',
      '1000',
    ],
  })
  await focus({ selector: '.card.selected > [aria-label="Resize card"]' })
  await press({ key: 'Home' })
  await check({
    condition: 'document.querySelector(".task-updates").clientHeight >= 80',
    label: 'minimum card height retains readable Updates',
  })
  await press({ key: 'End' })
  await eventually({
    condition: '(() => {const card=document.querySelector(".card.selected"); return card.getBoundingClientRect().height === Number(card.querySelector(".resize-y").getAttribute("aria-valuemax"));})()',
    label: 'open resizing stops at the complete Updates content maximum',
  })
  const fullHeight = state().view?.cardHeights[fixture.state.keys.layout!]
  assert.ok(fullHeight)
  await press({ key: 'Shift+ArrowDown' })
  await check({
    condition: `document.querySelector(".card.selected").getBoundingClientRect().height === ${fullHeight}`,
    label: 'resizing cannot add empty space after the full content',
  })
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await eventually({
    condition: `document.querySelector(".app")?.dataset.connected === "true" && !!document.querySelector(${JSON.stringify(card)})`,
    label: 'cards reload with the current saved layout',
  })
  await evaluate({ code: `const button = document.querySelector(${JSON.stringify(card)}); if (!button.closest('.card').classList.contains('selected')) button.click(); return true;` })
  await eventually({
    condition: `document.querySelector(".card.selected")?.getBoundingClientRect().height === ${fullHeight}`,
    label: 'full content height survives reload',
  })
  process.stdout.write('Composer and card drag resize browser smoke passed.\n')
} catch (error) {
  const evidence = process.env.PNYX_EVIDENCE_DIR ?? home
  writeFileSync(
    join(
      evidence,
      'resize-failure-state.json',
    ),
    JSON.stringify(
      state(),
      null,
      2,
    ),
  )
  writeFileSync(
    join(
      evidence,
      'resize-failure-browser.txt',
    ),
    await evaluate({ code: `const selected = document.querySelector('.card.selected'); const card = document.querySelector('[data-task="${fixture.state.keys.layout}"]'); const column = card?.closest('.column-cards'); const style = card && getComputedStyle(card); return {selected: selected?.dataset.task, card: card?.outerHTML, rendered: card?.getBoundingClientRect().toJSON(), column: column?.getBoundingClientRect().toJSON(), columnClient: column?.clientHeight, style: style && {height: style.height, minHeight: style.minHeight, maxHeight: style.maxHeight, flex: style.flex}, cache: sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.includes('hydra-state')))};` }),
  )
  await screenshot({ name: 'resize-failure.png' })
  throw error
} finally {
  await close(); await server.close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
