import assert from 'node:assert/strict'
import { hydraSdk } from './hydra-host-fixture.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server/server.ts'
import { loadHydra } from '../src/store/hydra-store.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-keyboard-smoke-',
))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
const fixture = seedWebFixture({ home })
const server = await startServer({
  hydraId: 'default',
  query: hydraSdk().query,
  homes: [fixture.nativeHome],
})
const {
  browser,
  evaluate,
  eventually,
  check,
  fill,
  press,
  focus,
  screenshot,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-keyboard',
})
const card = `[data-card="${fixture.state.keys.layout}"]`
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
  const platform = await browser({
    args: [
      'eval',
      '() => /Mac|iPhone|iPad/.test(navigator.platform)',
    ],
  })
  const mod = platform.includes('true') ? 'Meta' : 'Control'
  await focus({ selector: card }); await press({ key: `${mod}+b` })
  await check({
    condition: 'document.querySelector(".left-panel").hidden && document.querySelector(".hydra-chat").getBoundingClientRect().height > 800',
    label: 'Mod+B hides the left panel completely',
  })
  await press({ key: `${mod}+k` })
  await check({
    condition: '!document.querySelector(".left-panel").hidden && document.activeElement.matches("[data-oracle-slot] input") && !document.querySelector("[role=dialog]")',
    label: 'Mod+K reveals and focuses the one search field',
  })
  await focus({ selector: card }); await press({ key: 'ArrowDown' })
  await check({
    condition: `document.activeElement.dataset.card === ${JSON.stringify(fixture.state.keys.coverage)}`,
    label: 'arrows navigate cards',
  })
  await press({ key: 'k' }); await check({
    condition: `document.activeElement.matches(${JSON.stringify(card)})`,
    label: 'k navigates back',
  })
  await press({ key: `${mod}+ArrowRight` })
  await eventually({
    condition: `document.querySelector(${JSON.stringify(card)}).closest('[data-column]').dataset.column === 'parked'`,
    label: 'Mod+Right moves the highlighted task',
  })
  assert.equal(
    state().cards[fixture.state.keys.layout!]?.column,
    'parked',
  )
  await press({ key: `${mod}+ArrowLeft` })
  await eventually({
    condition: `document.querySelector(${JSON.stringify(card)}).closest('[data-column]').dataset.column === 'needs_you'`,
    label: 'Mod+Left moves it back',
  })
  await focus({ selector: '[data-column-heading=in_progress]' }); await press({ key: `${mod}+ArrowRight` })
  await eventually({
    condition: 'document.querySelectorAll(".column")[2].dataset.column === "in_progress"',
    label: 'Mod+arrows move the highlighted column',
  })
  await focus({ selector: card }); await press({ key: 'Enter' })
  await eventually({
    condition: 'document.activeElement.matches(".task-updates")',
    label: 'opening a card focuses Updates',
  })
  await focus({ selector: card }); await press({ key: 'r' })
  await check({
    condition: '!!document.querySelector(".task-updates") && !document.querySelector(".detail .composer")',
    label: 'reply shortcut keeps the card on Updates',
  })
  const sent = state().hydraMessages?.length ?? 0
  await focus({ selector: '.hydra-chat .composer textarea' }); await fill({
    label: 'Reply to Hydra',
    value: 'Hydra keyboard reply',
  }); await press({ key: 'Shift+Enter' })
  await check({
    condition: 'document.querySelector(".hydra-chat .composer textarea").value === "Hydra keyboard reply\\n"',
    label: 'Shift+Enter adds a line',
  })
  await press({ key: 'Enter' })
  await eventually({
    condition: 'document.querySelector(".hydra-chat .composer textarea").value === ""',
    label: 'Hydra keyboard send uses its own composer',
  })
  assert.equal(
    state().hydraMessages?.length,
    sent + 1,
  )
  await evaluate({ code: 'document.querySelector(".hydra-chat .composer textarea").focus(); return true;' })
  await press({ key: `${mod}+b` }); await check({
    condition: 'document.querySelector(".left-panel").hidden',
    label: 'Mod+B works while typing a reply',
  })
  await press({ key: `${mod}+k` }); await check({
    condition: 'document.activeElement.matches("[data-oracle-slot] input")',
    label: 'Mod+K works while typing',
  })
  await screenshot({ name: 'keyboard.png' })
  process.stdout.write('Keyboard browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
