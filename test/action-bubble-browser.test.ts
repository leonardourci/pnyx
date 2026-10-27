import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { browserFixture } from './browser-fixture.ts'

const browser = browserFixture()

test(
  'Action pills fit short text, cap long text, and shrink in a narrow running line',
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

    try {
      await browser({
        args: [
          'open',
          // Chrome on Linux keeps a spare connection open to a local server, which never lets it close.
          `data:text/html,${encodeURIComponent(markup)}`,
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
    }
  },
)
