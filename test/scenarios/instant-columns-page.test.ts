import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

for (const outcome of [
  'saved',
  'refused',
  'newer-draft',
  'cancelled-newer-draft',
]) {
  test(
    `column description previews immediately and handles ${outcome}`,
    async () => {
      const s = await pnyx.scenario()
      await s.owner({
        args: [
          'column',
          'describe',
          'queued',
          '--description',
          'Initial description',
        ],
      })
      const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })

      await page.shows({
        what: 'connected before editing a column',
        check: () => document.querySelector('[data-connected=true]'),
      })

      const edit = async () => {
        await page.click({ selector: '[aria-label="Queued column menu"]' })
        await page.click({
          selector: '.menu-items button',
          text: 'Edit description',
        })
        await page.shows({
          what: 'select description draft',
          check: () => {
            const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Queued description"]')
            field?.select()

            return !!field
          },
        })
      }

      await edit()
      await page.type({ text: 'Submitted description' })
      await page.shows({
        what: 'hold the description save',
        arg: { outcome },
        check: ({ outcome }) => {
          const send = WebSocket.prototype.send

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = JSON.parse(String(data))

            if (message.name === 'column' && message.args[0] === 'describe') {
              ;

              (window as unknown as { releaseDescription(): boolean }).releaseDescription = () => {
                if (this.readyState !== WebSocket.OPEN) {
                  return false
                }

                WebSocket.prototype.send = send
                const args = [...message.args]

                if (outcome !== 'saved') {
                  args[1] = 'missing-column'
                }

                send.call(
                  this,
                  JSON.stringify({
                    ...message,
                    args,
                  }),
                )

                return true
              }

              return
            }

            send.call(
              this,
              data,
            )
          }

          return true
        },
      })
      await page.click({
        selector: '.column-description button',
        text: 'Save description',
      })
      const immediate = await page.shows({
        what: 'the description submit frame',
        check: () => ({
          closed: !document.querySelector('.column-description'),
          description: document.querySelector('.column-queued h2')?.getAttribute('title'),
        }),
      })
      assert.deepEqual(
        immediate,
        {
          closed: true,
          description: 'Submitted description',
        },
      )
      assert.equal(
        s.state().config?.columns.find(column => column.role === 'queued')?.description,
        'Initial description',
      )

      if (outcome.includes('newer-draft')) {
        await edit()
        await page.type({ text: 'Newer description draft' })

        if (outcome === 'cancelled-newer-draft') {
          await page.click({
            selector: '.column-description button',
            text: 'Cancel',
          })
        }
      }

      // The page can send the save after the click, or resend it after a reconnect,
      // so release the latest held send once its socket is open.
      await page.shows({
        what: 'the held description save to release',
        check: () => (window as unknown as { releaseDescription?(): boolean })
          .releaseDescription?.(),
      })

      if (outcome === 'saved') {
        await page.shows({
          what: 'description committed',
          check: () => !document.querySelector('[data-pending]'),
        })
        assert.equal(
          s.state().config?.columns.find(column => column.role === 'queued')?.description,
          'Submitted description',
        )
      } else {
        await page.shows({
          what: 'description refusal is visible and the canonical heading returns',
          check: () => document.querySelector('.notice')
          && document.querySelector('.column-queued h2')?.getAttribute('title') === 'Initial description',
        })
        const recovered = await page.shows({
          what: 'description draft after refusal',
          check: () => ({
            value: document.querySelector<HTMLTextAreaElement>('[aria-label="Queued description"]')?.value ?? null,
          }),
        })
        let expected: string | null = 'Submitted description'

        if (outcome === 'cancelled-newer-draft') {
          expected = null
        } else if (outcome === 'newer-draft') {
          expected = 'Newer description draft'
        }

        assert.equal(
          recovered.value,
          expected,
        )
      }

      await page.close()
    },
  )
}
