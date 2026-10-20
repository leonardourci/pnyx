import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'
import { seedWebFixture } from './web-fixture.ts'

const home = mkdtempSync(join(tmpdir(), 'pnyx-snappy-'))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
process.env.HOME = home
process.env.CODEX_HOME = join(home, 'codex')
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
const probe = createServer()
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
const address = probe.address()
await promisify(probe.close.bind(probe))()
assert.ok(address && typeof address !== 'string')
process.env.PNYX_PASEO_URL = `ws://127.0.0.1:${address.port}/ws`
const fixture = seedWebFixture({ home })
const meta = { actor: 'fixture', at: new Date().toISOString() }

for (const hydraId of ['default', 'second', 'third']) {
  commands.hydra(['create', hydraId, '--name', hydraId])
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      for (let i = 0; i < 120; i++) {
        const decision = hydraEvent({ state: writer.state, meta, cardId: `${hydraId}-${i}`, change: { type: 'task.created', data: { key: `${hydraId}-${i}`, title: `${hydraId} task ${i}`, column: i % 2 ? 'in_progress' : 'queued' } } })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      }
    },
  })
}

appendFileSync(fixture.transcript, Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'assistant', timestamp: meta.at, message: { content: [{ type: 'text', text: `Update ${i}: ` + 'Checking the migration and its rollback path. '.repeat(20) }] } })).join('\n') + '\n')
const server = await startServer({ hydraId: 'default', homes: [fixture.nativeHome] })
const b = smokeBrowser({ home, session: 'pnyx-snappy' })
const card = `[data-card="${fixture.state.keys.layout}"]`

try {
  await b.browser({ args: ['open', server.url] }); await b.browser({ args: ['resize', '1800', '1000'] })
  await b.eventually({ condition: 'document.querySelectorAll(".card").length >= 120 && document.querySelector(".app")?.dataset.connected === "true"', label: 'realistic Hydra loaded' })
  await b.evaluate({ code: 'window.snappyDocument = performance.timeOrigin; window.blankFrames = 0; window.keepSampling = true; const sample = () => { if (!document.querySelector(\'.card\')) window.blankFrames++; if (window.keepSampling) requestAnimationFrame(sample); }; sample(); return true;' })
  await b.click({ selector: card })
  await b.eventually({ condition: '!!document.querySelector(".task-updates")', label: 'Updates loaded' })
  await b.fill({ label: 'Reply to Hydra', value: 'Draft kept on this Hydra' })
  await b.evaluate({
    code: `
    window.nativeSocketSend = WebSocket.prototype.send;
    window.saveDelay = 600; window.readDelay = 0; window.failNextSave = false; window.writes = []; window.received = new Set();
    WebSocket.prototype.send = function(data) {
      if (!this.snappyObserved) { this.snappyObserved = true; this.addEventListener('message', event => { const incoming = JSON.parse(event.data); if (incoming.id) window.received.add(incoming.id); }); }
      const m = JSON.parse(data);
      if (m.type === 'command' && (['view', 'move', 'column', 'task'].includes(m.name) || (['settings', 'rule'].includes(m.name) && m.args[0] === 'set'))) {
        window.writes.push(m);
        if (window.failNextSave) { m.args.push('--invalid-snappy-flag'); window.failNextSave = false; }
        setTimeout(() => window.nativeSocketSend.call(this, JSON.stringify(m)), window.saveDelay);
      } else if (m.type === 'command' && window.readDelay && ['settings', 'rule', 'history'].includes(m.name)) { setTimeout(() => window.nativeSocketSend.call(this, data), window.readDelay); } else { window.nativeSocketSend.call(this, data); }
    };
    return true;`,
  })
  await b.evaluate({
    code: `
    const handle = document.querySelector('.card.selected > [aria-label="Resize card"]'); handle.focus();
    const target = document.querySelector('.card.selected'); const before = target.getBoundingClientRect().height;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise(r => requestAnimationFrame(r));
    handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    for (let i = 0; i < 48; i++) { await new Promise(r => requestAnimationFrame(r)); if (target.getBoundingClientRect().height !== before + 8) throw new Error('Resize snapped back'); }
    if (getComputedStyle(handle).outlineStyle !== 'none') throw new Error('Resize outline');
    return true;`,
  })
  assert.equal(loadHydra({ hydraId: 'default' }).state.view?.cardHeights[fixture.state.keys.layout!], 488)
  await b.screenshot({ name: 'snappy-resize.png' })
  await b.evaluate({
    code: `
    window.originalThread = document.querySelector('.task-updates');
    const transfer = new DataTransfer(); transfer.setData('application/pnyx-task', 'default-0');
    document.querySelector('[data-column="in_progress"]').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    await new Promise(r => requestAnimationFrame(r));
    if (document.querySelector('[data-card="default-0"]').closest('[data-column]').dataset.column !== 'in_progress') throw new Error('Move waited for server');
    if (document.querySelector('.task-updates') !== window.originalThread) throw new Error('Unrelated Updates remounted');
    return true;`,
  })
  await b.eventually({ condition: 'window.writes.filter(m => m.name === "move").length === 1', label: 'move saved once' })
  await b.evaluate({
    code: `
    for (const label of ['Resize Queued column', 'Resize Parked column']) {
      const handle = document.querySelector('[aria-label="' + label + '"]');
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    }
    await new Promise(r => requestAnimationFrame(r));
    for (const id of ['queued', 'parked']) if (document.querySelector('[data-column="' + id + '"]').getBoundingClientRect().width !== 298) throw new Error('Concurrent resize waited');
    return true;`,
  })
  await b.eventually({ condition: 'window.writes.filter(m => m.name === "view").length === 3', label: 'overlapping view saves are serialized' })
  await b.evaluate({ code: 'await new Promise(r => setTimeout(r, 700)); return true;' })
  assert.equal(loadHydra({ hydraId: 'default' }).state.view?.columnWidths.queued, 298)
  assert.equal(loadHydra({ hydraId: 'default' }).state.view?.columnWidths.parked, 298)
  assert.equal(loadHydra({ hydraId: 'default' }).state.cards['default-0']?.column, 'in_progress')
  await b.evaluate({ code: 'window.failNextSave = true; const handle = document.querySelector(\'.card.selected > [aria-label="Resize card"]\'); handle.dispatchEvent(new KeyboardEvent(\'keydown\', { key: \'ArrowDown\', bubbles: true })); handle.dispatchEvent(new KeyboardEvent(\'keyup\', { key: \'ArrowDown\', bubbles: true })); await new Promise(r => requestAnimationFrame(r)); if (document.querySelector(\'.card.selected\').getBoundingClientRect().height !== 496) throw new Error(\'Failed save was not optimistic\'); return true;' })
  await b.eventually({ condition: 'document.querySelector(".card.selected")?.getBoundingClientRect().height === 488 && !!document.querySelector("[role=alert]")', label: 'failed resize reverts with a visible error' })
  await b.evaluate({ code: 'const handle = document.querySelector(\'.hydra-chat > .resize-x\'); handle.focus(); handle.dispatchEvent(new KeyboardEvent(\'keydown\', { key: \'ArrowRight\', bubbles: true })); handle.dispatchEvent(new KeyboardEvent(\'keyup\', { key: \'ArrowRight\', bubbles: true })); [...document.querySelectorAll(\'.hydra-name\')].find(el => el.textContent.trim() === \'second\').click(); await new Promise(r => requestAnimationFrame(r)); if (!document.querySelector(\'.card\')) throw new Error(\'Current Hydra disappeared\'); if (!document.querySelector(\'main [role=status]\')) throw new Error(\'Missing Hydra loading status\'); return true;' })
  await b.eventually({ condition: 'document.querySelector("[data-hydra-current]")?.textContent.trim() === "second" && document.querySelector(".app")?.dataset.connected === "true"', label: 'cold switch completes after saving the previous Hydra' })
  assert.equal(loadHydra({ hydraId: 'default' }).state.view?.hydraWidth, 368)
  assert.equal(loadHydra({ hydraId: 'second' }).state.view?.hydraWidth, undefined)
  await b.fill({ label: 'Reply to Hydra', value: 'Second Hydra draft' })
  await b.evaluate({
    code: `
    const at = performance.now(); [...document.querySelectorAll('.hydra-name')].find(el => el.textContent.trim() === 'default').click();
    for (let i = 0; i < 6; i++) { await new Promise(r => requestAnimationFrame(r)); if (document.querySelector('[data-hydra-current]')?.textContent.trim() === 'default') { window.cachedSwitchMs = performance.now() - at; return true; } }
    throw new Error('Cached Hydra did not switch immediately');`,
  })
  await b.eventually({ condition: 'document.querySelector(".app")?.dataset.connected === "true" && document.querySelector(".hydra-chat .composer textarea")?.value === "Draft kept on this Hydra"', label: 'cached Hydra restores its selection and draft' })
  await b.check({ condition: 'performance.timeOrigin === window.snappyDocument && window.blankFrames === 0', label: 'Hydra switches keep the document and never show an empty frame' })
  await b.evaluate({ code: 'history.back(); return true;' })
  await b.eventually({ condition: 'document.querySelector("[data-hydra-current]")?.textContent.trim() === "second" && document.querySelector(".app")?.dataset.connected === "true"', label: 'browser Back switches Hydras' })
  await b.evaluate({ code: 'history.forward(); return true;' })
  await b.eventually({ condition: 'document.querySelector("[data-hydra-current]")?.textContent.trim() === "default" && document.querySelector(".app")?.dataset.connected === "true"', label: 'browser Forward restores the Hydra' })
  await b.evaluate({
    code: `
    window.scenarioStart = window.writes.length; window.failNextSave = true;
    document.querySelector('.add-column button').click();
    await new Promise(r => requestAnimationFrame(r));
    const column = [...document.querySelectorAll('[data-column]')].find(el => el.dataset.column.startsWith('custom:'));
    if (!column) throw new Error('Column creation waited for server');
    for (const handle of [column.querySelector('.resize-x'), document.querySelector('.hydra-chat > .resize-x')]) {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      handle.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    }
    return true;`,
  })
  await b.eventually({ condition: 'window.writes.slice(window.scenarioStart).some(m => m.name === "view" && window.received.has(m.id)) && ![...document.querySelectorAll("[data-column]")].some(el => el.dataset.column.startsWith("custom:"))', label: 'failed creation settles its dependent resize and flushes the independent save' })
  assert.equal(loadHydra({ hydraId: 'default' }).state.view?.hydraWidth, 376)
  await b.evaluate({
    code: `
    window.nativeSocket = WebSocket; window.heldSockets = []; window.releaseCold = false;
    window.WebSocket = class extends window.nativeSocket {
      constructor(url) {
        super(url);
        if (new URL(url).pathname === '/hydra/third/ws') {
          this.held = []; window.heldSockets.push(this);
          this.addEventListener('message', event => { if (!window.releaseCold) { event.stopImmediatePropagation(); this.held.push(event.data); } });
        }
      }
    };
    [...document.querySelectorAll('.hydra-name')].find(el => el.textContent.trim() === 'third').click();
    for (let i = 0; i < 30 && !window.heldSockets.length; i++) await new Promise(r => requestAnimationFrame(r));
    if (!window.heldSockets.length) throw new Error('Cold socket not opened');
    [...document.querySelectorAll('.hydra-name')].find(el => el.textContent.trim() === 'second').click();
    return true;`,
  })
  await b.eventually({ condition: 'document.querySelector("[data-hydra-current]")?.textContent.trim() === "second" && document.querySelector(".app")?.dataset.connected === "true"', label: 'leaving a cold Hydra restores a confirmed cache' })
  await b.evaluate({
    code: `
    [...document.querySelectorAll('.hydra-name')].find(el => el.textContent.trim() === 'third').click();
    for (let i = 0; i < 30 && window.heldSockets.length < 2; i++) await new Promise(r => requestAnimationFrame(r));
    if (document.querySelector('[data-hydra-current]')?.textContent.trim() !== 'second' || document.querySelectorAll('.card').length < 120 || document.querySelector('.hydra-chat .composer textarea').value !== 'Second Hydra draft') throw new Error('Unconfirmed Hydra exposed another Hydra restore state');
    window.releaseCold = true;
    for (const socket of window.heldSockets) if (socket.readyState === window.nativeSocket.OPEN) for (const data of socket.held) socket.dispatchEvent(new MessageEvent('message', { data }));
    window.WebSocket = window.nativeSocket;
    return true;`,
  })
  await b.eventually({ condition: 'document.querySelector("[data-hydra-current]")?.textContent.trim() === "third" && document.querySelector(".app")?.dataset.connected === "true"', label: 'uncached Hydra appears only after its own confirmed snapshot' })
  await b.evaluate({ code: '[...document.querySelectorAll(\'.hydra-name\')].find(el => el.textContent.trim() === \'default\').click(); return true;' })
  await b.eventually({ condition: 'document.querySelector("[data-hydra-current]")?.textContent.trim() === "default" && document.querySelector(".app")?.dataset.connected === "true"', label: 'original Hydra remains usable after interrupted switches' })
  await b.evaluate({ code: 'window.keepSampling = false; window.readDelay = 2000; return { cachedSwitchMs: window.cachedSwitchMs, blankFrames: window.blankFrames };' })
  await b.text({ label: 'Settings' })
  await b.evaluate({ code: 'document.querySelector(".settings").scrollTop = 0; document.querySelector(".settings h1").focus({ preventScroll: true }); return true;' })
  await b.screenshot({ name: 'settings-loading.png' })
  await b.eventually({ condition: '!!document.querySelector(\'[aria-label="Semantic search"]\')', label: 'Settings finishes loading' })
  await b.evaluate({
    code: `
    const view = document.querySelector('[aria-label="Agent updates on cards"]');
    const before = view.getAttribute('aria-checked'); view.click();
    await new Promise(r => requestAnimationFrame(r));
    if (view.getAttribute('aria-checked') === before) throw new Error('Toggle waited for server');
    return true;`,
  })
  await b.evaluate({ code: 'await new Promise(r => setTimeout(r, 700)); return true;' })
  await b.text({ label: 'History' })
  await b.screenshot({ name: 'history-loading.png' })
  await b.eventually({ condition: '!!document.querySelector(".history-entry")', label: 'History finishes loading' })
  await b.browser({ args: ['open', server.url] })
  await b.eventually({ condition: '!!document.querySelector(".history-page") && document.querySelector(".app")?.dataset.connected === "true"', label: 'page selection survives reload after switching' })
  await b.evaluate({ code: '[...document.querySelectorAll(\'.hydra-name\')].find(el => el.textContent.trim() === \'second\').click(); return true;' })
  await b.eventually({ condition: 'document.querySelector(".hydra-chat .composer textarea")?.value === "Second Hydra draft"', label: 'another Hydra draft survives switching and a later document reload' })
  process.stdout.write('Snappy Hydra browser smoke passed.\n')
} finally {
  await b.close(); await server.close(); rmSync(home, { recursive: true, force: true })
}
