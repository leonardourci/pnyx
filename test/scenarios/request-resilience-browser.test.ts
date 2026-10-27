import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localToken } from '../../src/server/state.ts'
import { browserGroup } from '../../src/test-harness/browser.ts'
import { scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
)

test(
  'switching Hydras with chat images keeps running Codex workers and resolves images in their original Hydra',
  async () => {
    const source = await pnyx.scenario()
    const target = await pnyx.scenario()
    const base = `http://127.0.0.1:${pnyx.port()}`
    const uploaded = await fetch(
      `${base}/hydra/${source.hydraId}/attachments`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${localToken()}`,
          'content-type': 'image/png',
        },
        body: PNG,
      },
    )
    assert.equal(
      uploaded.status,
      200,
    )
    const image = await uploaded.json() as {
      path: string
      line: string
    }
    const legacy = image.line.replace(
      '/hydras/',
      '/boards/',
    )
    await source.chat({ text: `Look at this image.\n${image.line}\n${legacy}` })
    const workers: {
      key: string
      folder: string
      session: string
    }[] = []
    const held = []

    try {
      for (const key of [
        'first',
        'second',
      ]) {
        const folder = source.folder({ name: key })
        await source.owner({
          args: [
            'task',
            'create',
            '--key',
            key,
            '--title',
            key,
            '--folder',
            folder,
          ],
        })
        held.push(pnyx.codex.plan({
          text: '; silence changes nothing.',
          hold: true,
        }))
        await source.owner({
          args: [
            'task',
            'start',
            key,
            '--harness',
            'codex',
          ],
        })
        const agent = await source.agent({ cwd: folder })
        await until({
          what: `${key} worker to receive its opening turn`,
          check: () => agent.received.length === 1,
        })
        workers.push({
          key,
          folder,
          session: agent.id,
        })
      }

      const page = await chrome.open({ url: `${base}/hydra/${source.hydraId}/` })
      await page.shows({
        what: 'the source image to load',
        check: () => [...document.querySelectorAll<HTMLImageElement>('.hydra-chat img')].some(img => img.complete && img.naturalWidth === 1),
      })
      const rendered = await page.shows({
        what: 'current and migrated attachment paths to render',
        check: () => ({ images: document.querySelectorAll('.hydra-chat img').length }),
      })
      assert.equal(
        rendered.images,
        2,
      )
      await page.click({
        selector: '.hydra-name',
        text: target.hydraId,
      })
      await page.shows({
        what: 'the target Hydra to connect',
        arg: { id: target.hydraId },
        check: ({ id }) => document.querySelector('.hydra-name[aria-current=page]')?.textContent?.includes(id),
      })
      // Hold only the save receipt to reproduce switching before an in-flight command settles.
      await page.shows({
        what: 'a delayed chat save receipt',
        check: () => {
          const send = WebSocket.prototype.send

          // eslint-disable-next-line pnyx/object-params -- WebSocket owns its send signature.
          WebSocket.prototype.send = function (data) {
            const message = JSON.parse(String(data))

            if (message.type === 'command' && message.name === 'hydra' && message.args[0] === 'send') {
              const receive = this.onmessage!

              this.onmessage = event => {
                const answer = JSON.parse(String(event.data))

                if (answer.id === message.id && [
                  'receipt',
                  'error',
                ].includes(answer.type)) {
                  document.documentElement.dataset.receiptHeld = message.id
                  document.addEventListener(
                    'release-receipt',
                    () => receive.call(
                      this,
                      event,
                    ),
                    { once: true },
                  )
                } else {
                  receive.call(
                    this,
                    event,
                  )
                }
              }

              WebSocket.prototype.send = send
            }

            return send.call(
              this,
              data,
            )
          }

          return true
        },
      })
      await page.click({ selector: '.hydra-chat textarea' })
      await page.type({ text: 'Save this while I switch Hydras.' })
      await page.press({ key: 'Enter' })
      await page.shows({
        what: 'the save receipt to be held in transit',
        check: () => document.documentElement.dataset.receiptHeld,
      })
      await page.click({
        selector: '.hydra-name',
        text: source.hydraId,
      })
      await page.shows({
        what: 'the cached source chat to render before its save settles',
        arg: { id: source.hydraId },
        check: ({ id }) => document.querySelector('.hydra-name[aria-current=page]')?.textContent?.includes(id)
        && document.querySelector('.hydra-chat .messages')?.textContent?.includes('Look at this image.'),
      })
      await page.shows({
        what: 'the image request to settle',
        check: () => [...document.querySelectorAll<HTMLImageElement>('.hydra-chat img')].every(img => img.complete),
      })
      const images = await page.shows({
        what: 'the image requests made while switching',
        check: () => performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)
          .filter(path => path.includes('/attachments/')),
      })
      assert.ok(images.length > 0)
      await page.shows({
        what: 'the saved receipt to be released',
        check: () => {
          document.dispatchEvent(new Event('release-receipt'))

          return true
        },
      })
      assert.deepEqual(
        [...new Set(images)],
        [`/hydra/${source.hydraId}/attachments/${image.path.split('/').at(-1)}`],
      )
      await page.shows({
        what: 'navigation to finish with the image still visible',
        arg: { id: source.hydraId },
        check: ({ id }) => document.querySelector('base')?.getAttribute('href') === `/hydra/${id}/`
          && [...document.querySelectorAll<HTMLImageElement>('.hydra-chat img')].filter(img => img.complete && img.naturalWidth === 1).length === 2,
      })
      assert.equal(
        (await fetch(`${base}/health`)).status,
        200,
      )

      for (const worker of workers) {
        const card = source.task({ key: worker.key })
        assert.equal(
          card.agent?.sessionId,
          worker.session,
        )
        assert.equal(
          card.sessionActivity,
          'working',
        )
        assert.equal(
          source.received({ cwd: worker.folder }).length,
          1,
        )
        assert.ok(!card.attention.some(item => item.kind === 'interrupted'))
      }

      await page.close()
    } finally {
      held.forEach(turn => turn.release())
    }
  },
)
