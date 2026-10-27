import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './scenarios/browser.ts'

const chrome = browserGroup()

// The pointer's arrival stands in for a banner that loads after the click aimed: everything moves
// down once, so the old aim point now holds the button above the target.
const PAGE = `<!doctype html>
<button id="above" style="display:block;width:200px;height:60px">above</button>
<button id="target" style="display:block;width:200px;height:60px">target</button>
<script>
  window.clicks = []
  for (const button of document.querySelectorAll('button')) {
    button.addEventListener('mousedown', () => clicks.push(button.id + ' down'))
    button.addEventListener('click', () => clicks.push(button.id))
  }
  addEventListener('mousemove', () => {
    const banner = document.createElement('p')
    banner.style.cssText = 'height:60px;margin:0'
    document.body.prepend(banner)
  }, { once: true })
</script>`

test(
  'a click reaches only its element when the page moves it between aiming and pressing',
  async () => {
    const page = await chrome.open({ url: `data:text/html,${encodeURIComponent(PAGE)}` })
    await page.shows({
      what: 'the page',
      check: () => document.querySelector('#target'),
    })
    await page.click({ selector: '#target' })
    assert.deepEqual(
      await page.evaluate({ expression: 'window.clicks' }),
      [
        'target down',
        'target',
      ],
    )
    await page.close()
  },
)
