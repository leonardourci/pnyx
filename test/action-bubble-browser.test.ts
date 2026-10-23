import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { promisify } from 'node:util'

test(
  'Action pills fit short text, cap long text, and shrink in a narrow running line',
  { skip: process.env.PNYX_BROWSER_TESTS !== '1' },
  async () => {
    const assets = new URL(
      '../dist/web/assets/',
      import.meta.url,
    )
    const css = readdirSync(assets).filter(name => name.endsWith('.css'))
      .map(name => readFileSync(
        new URL(
          name,
          assets,
        ),
        'utf8',
      ))
      .join('\n')
    const markup = `<!doctype html><style>${css}</style><div class="chat-running-status" style="width:600px">
      <span>28s</span><span class="action-bubble"><span class="live-label" style="width:1000px">
      <span class="live-label-item"><span class="action-text">Reading a very long configuration filename that needs an ellipsis.ts</span></span>
      </span></span></div>`
    const server = createServer((
      _,
      response,
    ) => response.end(markup))
    await new Promise<void>(resolve => server.listen(
      0,
      '127.0.0.1',
      resolve,
    ))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const env = {
      ...process.env,
      CHROME_DEVTOOLS_AXI_SESSION: `pnyx-action-${address.port}`,
      CHROME_DEVTOOLS_AXI_PORT: String(address.port),
      CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '',
      CHROME_DEVTOOLS_AXI_HEADED: '0',
    }
    const bridge = createServer()
    await new Promise<void>(resolve => bridge.listen(
      0,
      '127.0.0.1',
      resolve,
    ))
    const bridgeAddress = bridge.address()
    assert.ok(bridgeAddress && typeof bridgeAddress === 'object')
    env.CHROME_DEVTOOLS_AXI_PORT = String(bridgeAddress.port)
    await new Promise<void>(resolve => bridge.close(() => resolve()))

    const browser = async ({ args }: { args: string[] }) => {
      const result = await promisify(execFile)(
        'chrome-devtools-axi',
        args,
        {
          env,
          encoding: 'utf8',
          timeout: 30_000,
        },
      )

      return result.stdout
    }

    try {
      await browser({
        args: [
          'open',
          `http://127.0.0.1:${address.port}`,
        ],
      })
      const result = await browser({
        args: [
          'eval',
          `() => {
        const pill = document.querySelector('.action-bubble');
        const text = document.querySelector('.action-text');
        const label = document.querySelector('.live-label');
        const row = document.querySelector('.chat-running-status');
        label.style.transition = 'none';
        const cap = pill.getBoundingClientRect().width;
        const ellipsis = text.scrollWidth > text.clientWidth;
        row.style.width = '120px';
        const narrow = pill.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1;
        row.style.width = '600px';
        label.style.width = '70px';
        text.textContent = 'Reading a.ts';
        const short = pill.getBoundingClientRect().width;
        return {cap, ellipsis, narrow, short, passed: cap < 300 && ellipsis && narrow && short < 100};
      }`,
        ],
      })
      assert.match(
        result,
        /passed.*true/,
      )
    } finally {
      await browser({ args: ['stop'] })
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  },
)
