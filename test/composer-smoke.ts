import { hydraSdk } from './hydra-host-fixture.ts'
import { effectiveDispatch } from '../src/dispatch/config.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hydraConfig, hydraEvent } from '../src/core/hydra.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'
import { fakeCodex } from './codex-fixture.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-composer-smoke-',
))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
process.env.CODEX_HOME = join(
  home,
  'codex',
)
const fixture = seedWebFixture({ home })
const codex = fakeCodex({ root: home })
const server = await startServer({
  query: hydraSdk().query,
  spawnCodex: codex.spawnCodex,
  hydraId: 'default',
  homes: [fixture.nativeHome],
})
const {
  browser,
  evaluate,
  check,
  eventually,
  click,
  text,
  fill,
  screenshot,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-composer',
})
const state = () => loadHydra({ hydraId: 'default' }).state

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
      '900',
    ],
  })
  await browser({
    args: [
      'wait',
      'Needs you',
    ],
  })
  await check({
    condition: 'getComputedStyle(document.querySelector(".hydra-chat .composer")).borderTopWidth === "1px" && getComputedStyle(document.querySelector(".hydra-chat .composer")).borderTopLeftRadius === "16px" && document.querySelector(".hydra-chat textarea").clientHeight <= 30 && !document.querySelector(".hydra-chat [aria-label=\\"Resize composer\\"]")',
    label: 'composer is a framed box resting at one line, with no drag handle',
  })
  await evaluate({ code: 'window.composerRest = document.querySelector(".hydra-chat .composer").clientHeight; return true;' })
  await screenshot({ name: 'composer-after.png' })
  await fill({
    label: 'Reply to Hydra',
    value: 'First line\nSecond line\nThird line',
  })
  await eventually({
    condition: 'document.querySelector(".hydra-chat .composer").clientHeight > window.composerRest',
    label: 'draft grows with its content',
  })
  await fill({
    label: 'Reply to Hydra',
    value: Array.from(
      { length: 60 },
      (
        _,
        i,
      ) => `Line ${i}`,
    ).join('\n'),
  })
  await eventually({
    condition: 'Math.abs(document.querySelector(".hydra-chat .composer").offsetHeight - Math.min(480, document.querySelector(".hydra-chat").clientHeight / 2)) <= 1',
    label: 'growth stops at half the panel, at most 480 px',
  })
  await check({
    condition: 'document.querySelector(".hydra-chat textarea").scrollHeight > document.querySelector(".hydra-chat textarea").clientHeight && getComputedStyle(document.querySelector(".hydra-chat textarea")).overflowY === "auto"',
    label: 'long draft scrolls inside the composer',
  })
  await screenshot({ name: 'composer-long.png' })
  await fill({
    label: 'Reply to Hydra',
    value: '',
  })
  await eventually({
    condition: 'document.querySelector(".hydra-chat .composer").clientHeight === window.composerRest',
    label: 'empty draft shrinks again',
  })
  await click({ selector: '.hydra-chat [aria-label="Add to message"]' })
  await text({ label: 'Mention' })
  await check({
    condition: 'document.querySelector(".hydra-chat textarea").value === "@" && document.activeElement.matches(".hydra-chat textarea") && !!document.querySelector(".mention-menu")',
    label: 'plus inserts the mention hook at the caret and opens the picker',
  })
  await fill({
    label: 'Reply to Hydra',
    value: '',
  })
  await evaluate({ code: 'const input = document.querySelector(".hydra-chat input[type=file]"); const files = new DataTransfer(); files.items.add(new File(["const result = 42"], "example.ts", { type: "text/plain" })); input.files = files.files; input.dispatchEvent(new Event("change", { bubbles: true })); return true;' })
  await eventually({
    condition: 'document.querySelector(".hydra-chat textarea").value.startsWith("example.ts") && document.querySelector(".hydra-chat .draft-chip[data-kind=file]")?.textContent === "example.ts"',
    label: 'an attached file shows as one chip',
  })
  await fill({
    label: 'Reply to Hydra',
    value: '',
  })
  await check({
    condition: '[...document.querySelectorAll(".hydra-chat [role=combobox]")].map(x => x.getAttribute("aria-label")).join(",") === "Model,Effort,Permissions" && document.querySelector(".hydra-chat [aria-label=\\"Fast mode\\"]")?.getAttribute("aria-pressed") === "false" && !document.querySelector(".hydra-chat [role=dialog]")',
    label: 'Hydra settings are directly in the composer, with agent and model in one picker',
  })
  await click({ selector: '.hydra-chat [aria-label=Model]' })
  await eventually({
    condition: '[...document.querySelectorAll("[role=listbox][aria-label=Model] .select-group")].map(x => x.textContent).join(",") === "Claude Code,Codex" && !!document.querySelector("[role=listbox][aria-label=Model] [role=option][data-group=Codex]")',
    label: 'the model picker lists each agent with its models',
  })
  await click({ selector: '[role=listbox][aria-label=Model] [role=option][data-group=Codex]' })
  await eventually({
    condition: '!!document.querySelector(".hydra-chat [aria-label=Model]:not(:disabled)") && !document.querySelector("[role=listbox][aria-label=Model]")',
    label: 'a Codex model switches the agent for the next message',
  })
  assert.ok(codex.messages().some(message => message.method === 'model/list'))
  assert.ok(codex.messages().some(message => message.method === 'config/read'))
  assert.ok(codex.environments.every(env => env.CODEX_HOME === process.env.CODEX_HOME))
  assert.equal(
    effectiveDispatch({
      hydraId: 'default',
      state: state(),
    }).dispatch.rules.hydra,
    undefined,
  )
  assert.equal(
    state().config?.hydra.agent?.harness,
    'codex',
  )
  await screenshot({ name: 'composer-picker.png' })
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const config = hydraConfig({ state: writer.state })
      const decision = hydraEvent({
        state: writer.state,
        cardId: '$board',
        meta: {
          actor: 'fixture',
          at: new Date().toISOString(),
        },
        change: {
          type: 'board.configured',
          data: {
            ...config,
            hydra: {
              id: 'fixture-firstmate',
              name: 'Hydra',
              kind: 'firstmate',
              home: fixture.nativeHome,
            },
          },
        },
      })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    },
  })
  await eventually({
    condition: '!document.querySelector(".hydra-chat .agent-picker")',
    label: 'Firstmate-linked Hydra never offers its own agent settings',
  })
  await browser({
    args: [
      'resize',
      '700',
      '500',
    ],
  })
  await fill({
    label: 'Reply to Hydra',
    value: 'A long draft\n'.repeat(30),
  })
  await check({
    condition: 'document.querySelector(".hydra-chat .composer").offsetHeight <= document.querySelector(".hydra-chat").clientHeight / 2 + 1',
    label: 'short pane also caps automatic growth',
  })
  await screenshot({ name: 'composer-short.png' })
  await fill({
    label: 'Reply to Hydra',
    value: 'Keep this draft.',
  })
  const beforeOversize = state().seq
  await evaluate({ code: 'const input = document.querySelector(".hydra-chat input[type=file]"); const files = new DataTransfer(); for (const name of ["first.txt", "second.txt"]) files.items.add(new File(["x".repeat(40 * 1024)], name, { type: "text/plain" })); input.files = files.files; input.dispatchEvent(new Event("change", { bubbles: true })); return true;' })
  await eventually({
    condition: 'document.querySelector(".app > [role=status]")?.textContent.includes("Files and draft exceed")',
    label: 'aggregate insertion reports the message limit',
  })
  await check({
    condition: 'document.querySelector(".hydra-chat textarea").value === "Keep this draft." && document.querySelector(".app").dataset.connected === "true"',
    label: 'aggregate file payload is rejected without replacing the draft or disconnecting',
  })
  await evaluate({ code: 'const input = document.querySelector(".hydra-chat textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "界".repeat(25 * 1024)); input.dispatchEvent(new Event("input", { bubbles: true })); return true;' })
  await click({ selector: '.hydra-chat .composer-send' })
  await eventually({
    condition: 'document.querySelector(".hydra-chat .send-error")?.textContent.includes("64 KiB")',
    label: 'oversized UTF-8 reply reports failure before transport, with its time',
  })
  await check({
    condition: 'document.querySelector(".hydra-chat textarea").value.length === 25 * 1024 && document.querySelector(".app").dataset.connected === "true"',
    label: 'oversized draft stays intact and connected',
  })
  assert.equal(
    state().seq,
    beforeOversize,
  )
  const consoleOutput = await browser({ args: ['console'] })
  assert.doesNotMatch(
    consoleOutput,
    /TypeError|ReferenceError|Uncaught|ResizeObserver loop/,
  )
  process.stdout.write('Composer and agent picker browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
