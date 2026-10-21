import assert from 'node:assert/strict'
import { hydraSdk } from './hydra-host-fixture.ts'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startServer } from '../src/server/server.ts'
import { seedWebFixture } from './web-fixture.ts'
import { decidePush } from '../src/core/decide.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { smokeEnvironment } from './browser.ts'

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-connection-',
))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
const fixture = seedWebFixture({ home })
let server = await startServer({
  query: hydraSdk().query,
  hydraId: 'default',
  homes: [fixture.nativeHome],
})
const port = server.port, url = server.url
const exec = promisify(execFile)
const env = await smokeEnvironment({ session: 'pnyx-connection' })

const browser = async ({ args }: { args: string[] }) => {
  const { stdout } = await exec(
    'chrome-devtools-axi',
    args,
    {
      env,
      timeout: 45000,
      maxBuffer: 2 * 1024 * 1024,
    },
  )
  assert.doesNotMatch(
    stdout,
    /^error:/m,
  )

  return stdout
}

const evaluate = ({ code }: { code: string }) => browser({
  args: [
    'eval',
    code,
  ],
})
const until = ({ condition }: { condition: string }) => evaluate({ code: `async () => { for (let i = 0; i < 200; i++) { if (${condition}) return true; await new Promise(r => setTimeout(r, 100)); } throw new Error(${JSON.stringify(condition)}); }` })
const fill = ({
  selector,
  text,
}: {
  selector: string
  text: string
}) => evaluate({ code: `() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; }` })
const send = () => evaluate({ code: '() => { document.querySelector(".hydra-chat .composer").requestSubmit(); return true; }' })

const delivery = ({ text }: { text: string }) =>
  loadHydra({ hydraId: 'default' }).state.hydraMessages?.filter(message => message.text === text).length ?? 0

try {
  await browser({
    args: [
      'open',
      url,
    ],
  })
  await browser({
    args: [
      'wait',
      'Shape the first working Hydra',
    ],
  })
  await evaluate({ code: '() => { document.querySelector(\'[aria-label="Open task Shape the first working Hydra"]\').click(); window.connectionMarker = "same document"; return true; }' })
  await until({ condition: '!!document.querySelector(".task-updates") && (document.querySelector(".app").dataset.connected === "true")' })
  await server.close()
  await until({ condition: '!(document.querySelector(".app").dataset.connected === "true")' })
  await until({ condition: '!!document.querySelector(".hydra-chat .composer textarea:not(:disabled)") && !document.querySelector(".error-banner")' })
  await fill({
    selector: '.hydra-chat .composer textarea',
    text: 'Queued during restart',
  })
  await until({ condition: '!document.querySelector(".hydra-chat .composer-send").disabled' })
  await send()
  assert.equal(
    delivery({ text: 'Queued during restart' }),
    0,
  )
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const d = decidePush({
        state: writer.state,
        newCardId: `c${writer.state.seq + 1}`,
        key: 'layout',
        input: { title: 'Recovered task' },
        meta: {
          actor: 'fixture',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in d); writer.append({ event: d.event })
    },
  })
  server = await startServer({
    query: hydraSdk().query,
    hydraId: 'default',
    port,
    homes: [fixture.nativeHome],
  })
  await until({ condition: '(document.querySelector(".app").dataset.connected === "true") && document.querySelector(".hydra-chat .composer textarea").value === "" && document.body.textContent.includes("Recovered task")' })
  assert.equal(
    delivery({ text: 'Queued during restart' }),
    1,
  )
  await until({ condition: 'window.connectionMarker === "same document"' })
  appendFileSync(
    fixture.transcript,
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { content: 'Subscription restored' },
    }) + '\n',
  )

  await fill({
    selector: '.hydra-chat .composer textarea',
    text: 'Pending send across reload',
  })
  await evaluate({ code: '() => { const send = WebSocket.prototype.send; WebSocket.prototype.send = function(data) { const m = JSON.parse(data); if (m.type !== \'command\' || m.name !== \'hydra\') send.call(this, data); }; return true; }' })
  await send()
  assert.equal(
    delivery({ text: 'Pending send across reload' }),
    0,
  )
  await fill({
    selector: '.hydra-chat .composer textarea',
    text: 'Next draft while sending',
  })
  await browser({
    args: [
      'open',
      url,
    ],
  })
  await until({ condition: 'document.querySelector(".hydra-chat .composer textarea")?.value === "Next draft while sending" && document.body.textContent.includes("Pending send across reload")' })
  assert.equal(
    delivery({ text: 'Pending send across reload' }),
    1,
  )
  await fill({
    selector: '.hydra-chat .composer textarea',
    text: 'Draft across reload',
  })
  await browser({
    args: [
      'open',
      url,
    ],
  })
  await until({ condition: 'document.querySelector(".hydra-chat .composer textarea")?.value === "Draft across reload"' })
  assert.equal(
    loadHydra({ hydraId: 'default' }).state.cards[fixture.state.keys.layout!]?.agent?.sessionId,
    'fixture-layout',
  )
  await evaluate({ code: '() => { window.connectionMarker = \'heartbeat\'; const send = WebSocket.prototype.send; WebSocket.prototype.send = function(data) { if (JSON.parse(data).type !== \'ping\') send.call(this, data); }; const Native = WebSocket; window.reconnects = 0; window.WebSocket = class extends Native { constructor(...args) { super(...args); window.reconnects++; } }; return true; }' })
  await evaluate({ code: 'async () => { for (let i = 0; i < 380; i++) { if (window.reconnects > 0 && (document.querySelector(\'.app\').dataset.connected === \'true\')) return true; await new Promise(r => setTimeout(r, 100)); } throw new Error(\'heartbeat did not recover a silent socket\'); }' })
  await until({ condition: 'window.connectionMarker === "heartbeat" && !!document.querySelector(".hydra-chat .composer textarea:not(:disabled)")' })
  const events = readEvents({ hydraId: 'default' })
  withWriter({
    hydraId: 'other',
    fn: ({ writer }) => {
      for (const event of events) {
        const copy = structuredClone(event)

        if ((copy.type === 'task.created' || copy.type === 'card.pushed') && copy.data.title === 'Recovered task') {
          copy.data.title = 'Different Hydra'
        }

        writer.append({ event: copy })
      }
    },
  })
  assert.equal(
    loadHydra({ hydraId: 'other' }).state.seq,
    loadHydra({ hydraId: 'default' }).state.seq,
  )
  await fill({
    selector: '.hydra-chat .composer textarea',
    text: 'Only for the original Hydra',
  })
  await server.close()
  server = await startServer({
    query: hydraSdk().query,
    hydraId: 'other',
    port,
    homes: [fixture.nativeHome],
  })
  // Both Hydras share the server's address; the other one's page keeps none of this one's tab state.
  await browser({
    args: [
      'open',
      new URL(
        '/hydra/other/',
        url,
      ).href,
    ],
  })
  await browser({
    args: [
      'wait',
      'Different Hydra',
    ],
  })
  await until({ condition: '!document.body.textContent.includes("Recovered task") && !document.querySelector(".task-updates") && (document.querySelector(".app").dataset.connected === "true")' })
  process.stdout.write('Connection smoke passed: offline sends, event resync, subscription restore, reload and heartbeat recovery\n')
} catch (error) {
  const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(
    tmpdir(),
    'pnyx-connection-evidence',
  )
  mkdirSync(
    evidence,
    { recursive: true },
  )
  writeFileSync(
    join(
      evidence,
      'connection-failure.txt',
    ),
    String(error),
  )
  writeFileSync(
    join(
      evidence,
      'connection-dom.txt',
    ),
    await evaluate({ code: '() => document.documentElement.outerHTML' }).catch(String),
  )
  writeFileSync(
    join(
      evidence,
      'connection-console.txt',
    ),
    await browser({ args: ['console'] }).catch(String),
  )
  throw error
} finally {
  await server.close()
  await browser({ args: ['stop'] }).catch(() => undefined)
  rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
