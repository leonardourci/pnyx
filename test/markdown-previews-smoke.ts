import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { decideView } from '../src/core/decide.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { withWriter } from '../src/store/hydra-store.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(tmpdir(), 'pnyx-markdown-previews-'))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home })
const preview = 'Needle **ready** [PR](https://github.com/example/project/pull/42)'
const markdown = readFileSync(join(import.meta.dirname, 'fixtures/web/chat.md'), 'utf8')
appendFileSync(fixture.transcript, JSON.stringify({ type: 'user', timestamp: '2026-10-15T11:00:00Z', message: { content: markdown } }) + '\n')
appendFileSync(fixture.transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-10-15T11:01:00Z', message: { content: preview } }) + '\n')
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const meta = { actor: 'fixture', at: '2026-10-15T11:00:00Z' }
    const view = decideView({ state: writer.state, meta, patch: { lastMessageOnCards: true } })

    if ('event' in view) {
      writer.append({ event: view.event })
    }

    const message = hydraEvent({ state: writer.state, meta, cardId: '$board', change: { type: 'hydra.message', data: { action: 'send', text: markdown, hydra: 'hydra' } } })
    assert.ok('event' in message); writer.append({ event: message.event })
  },
})
commands.task(['status', fixture.state.keys.layout!, 'working', '--note', preview, '--actor', 'worker'])
const server = await startServer({ hydraId: 'default', homes: [fixture.nativeHome] })
const { browser, check, eventually, click, text, fill, screenshot, close } = smokeBrowser({ home, session: 'pnyx-markdown-previews' })

try {
  await browser({ args: ['open', server.url] }); await browser({ args: ['resize', '1440', '1000'] }); await browser({ args: ['wait', 'Needle'] })
  await screenshot({ name: 'message-previews.png' })
  await check({ condition: '!!document.querySelector(".last-message .markdown strong") && [...document.querySelectorAll(".last-message a")].some(a => a.href === "https://github.com/example/project/pull/42")', label: 'card message previews render emphasis and clickable PR links' })
  await check({ condition: '!!document.querySelector(".hydra-chat .markdown h1") && !!document.querySelector(".hydra-chat .markdown table") && !!document.querySelector(".hydra-chat .markdown blockquote") && !!document.querySelector(".hydra-chat .markdown .code-block")', label: 'Hydra messages render the complete Markdown document' })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` })
  await eventually({ condition: '!!document.querySelector(".detail .message.mine .markdown h1")', label: 'user messages share the Markdown renderer' })
  await check({ condition: '[...document.querySelectorAll(".messages .markdown")].every(el => el.scrollWidth <= el.clientWidth + 1) && !window.pnyxUnsafe && !document.querySelector(".messages script,.messages img,.messages iframe,.messages [onerror]")', label: 'full Markdown stays contained and raw HTML stays inert in both conversations' })
  await fill({ label: 'Oracle', value: 'Needle' })
  await eventually({ condition: '!!document.querySelector(".oracle-hit")', label: 'Oracle finds the message' })
  await screenshot({ name: 'oracle-markdown.png' })
  await check({ condition: '!!document.querySelector(".oracle-hit .markdown strong") && [...document.querySelectorAll(".oracle-hit a")].some(a => a.href === "https://github.com/example/project/pull/42") && !document.querySelector(".oracle-hit button a")', label: 'Oracle previews render Markdown links outside the task button' })
  await check({ condition: '[...document.querySelectorAll(".oracle-hit a")].every(a => a.target === "_blank" && a.relList.contains("noopener") && a.relList.contains("noreferrer"))', label: 'Oracle links open safely in a new tab' })

  for (const query of ['project', 'github']) {
    await fill({ label: 'Oracle', value: query })
    await eventually({ condition: '!!document.querySelector(".oracle-hit .markdown a")', label: `Oracle finds URL match ${query}` })
    await check({ condition: '[...document.querySelectorAll(".oracle-hit .markdown a")].some(a => a.getAttribute("href") === "https://github.com/example/project/pull/42")', label: `Oracle keeps the original PR URL when matching ${query}` })
  }

  await text({ label: 'History' })
  await eventually({ condition: '!!document.querySelector(".history-entry .markdown h1") && !!document.querySelector(".history-entry .markdown table") && !!document.querySelector(".history-entry .markdown .code-block")', label: 'History events render full Hydra messages as Markdown' })
  await check({ condition: '[...document.querySelectorAll(".history-entry .markdown")].every(el => el.scrollWidth <= el.clientWidth + 1)', label: 'History keeps long messages inside its results pane' })
  await fill({ label: 'Search history', value: 'Needle' })
  await eventually({ condition: '!!document.querySelector(".history-entry")', label: 'History finds the message' })
  await screenshot({ name: 'history-markdown.png' })
  await check({ condition: '!!document.querySelector(".history-entry .markdown strong") && [...document.querySelectorAll(".history-entry a")].some(a => a.href === "https://github.com/example/project/pull/42")', label: 'History previews render emphasis and clickable PR links' })

  for (const query of ['project', 'github']) {
    await fill({ label: 'Search history', value: 'quuxxyzmissing abcdefmissing' })
    await eventually({ condition: 'document.querySelector(".history-results .empty")?.textContent === "No matching history."', label: 'History clears previous results before the next URL match' })
    await fill({ label: 'Search history', value: query })
    await eventually({ condition: 'document.querySelector(".history-results").getAttribute("aria-busy") === "false" && !!document.querySelector(".history-entry .markdown a")', label: `History finds URL match ${query}` })
    await check({ condition: '[...document.querySelectorAll(".history-entry .markdown a")].some(a => a.getAttribute("href") === "https://github.com/example/project/pull/42")', label: `History keeps the original PR URL when matching ${query}` })
  }

  const consoleOutput = await browser({ args: ['console'] }); assert.doesNotMatch(consoleOutput, /TypeError|ReferenceError|Uncaught/)
  process.stdout.write('Markdown previews browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(home, { recursive: true, force: true })
}
