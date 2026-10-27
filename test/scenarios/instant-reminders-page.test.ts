import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from '../../src/test-harness/browser.ts'
import { scenarioGroup } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

for (const outcome of [
  'saved',
  'refused',
  'reconnect',
  'newer-draft',
]) {
  test(
    `reminder edits appear before confirmation and handle ${outcome}`,
    async () => {
      const s = await pnyx.scenario()
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'remember',
          '--title',
          'Remember this',
        ],
      })
      const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
      await page.shows({
        what: 'connected task',
        check: () => document.querySelector('[data-connected=true]') && document.querySelector('.card'),
      })
      await page.click({ selector: '.card-open' })
      await page.shows({
        what: 'selected task',
        check: () => document.querySelector('.card.selected .task-updates'),
      })
      await page.click({ selector: '[aria-label="Remind"]' })
      const when = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
      await page.type({ text: when })
      await page.shows({
        what: 'hold the reminder save',
        arg: { outcome },
        check: ({ outcome }) => {
          const control = window as unknown as {
            holdReminder: boolean
            reminderIds: string[]
            releaseReminder(): void
            disconnectReminder(): void
          }
          control.holdReminder = true
          control.reminderIds = []
          let refuse = outcome === 'refused' || outcome === 'newer-draft'
          const send = WebSocket.prototype.send

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = JSON.parse(String(data))

            if (message.name === 'task' && message.args[0] === 'remind') {
              control.reminderIds.push(message.args[message.args.indexOf('--event-id') + 1])

              if (control.holdReminder) {
                control.disconnectReminder = () => this.close()

                control.releaseReminder = () => {
                  control.holdReminder = false
                  const args = [...message.args]

                  if (refuse) {
                    args[1] = 'missing-task'
                  }

                  refuse = false
                  send.call(
                    this,
                    JSON.stringify({
                      ...message,
                      args,
                    }),
                  )
                }

                return
              }
            }

            send.call(
              this,
              data,
            )
          }

          return true
        },
      })

      if (process.env.PNYX_CAPTURE_REMINDERS && outcome === 'saved') {
        await page.capture({ path: `${process.env.PNYX_CAPTURE_REMINDERS}/before.png` })
      }

      await page.click({
        selector: '.reminder-editor button',
        text: 'Set reminder',
      })

      if (process.env.PNYX_CAPTURE_REMINDERS && outcome === 'saved') {
        await page.capture({ path: `${process.env.PNYX_CAPTURE_REMINDERS}/after-submit.png` })
      }

      const immediate = await page.shows({
        what: 'the submit frame before confirmation',
        check: () => ({
          closed: !document.querySelector('.reminder-editor'),
        }),
      })
      assert.equal(
        immediate.closed,
        true,
      )
      await page.shows({
        what: 'editor closes and reminder is visible before saving',
        arg: { when },
        check: ({ when }) =>
          !document.querySelector('.reminder-editor') && document.querySelector('.reminder-label')?.getAttribute('title') === when && document.querySelector('[data-pending]'),
      })
      assert.equal(
        s.task({ key: 'remember' }).reminder,
        undefined,
      )
      const attempt = await page.shows({
        what: 'the durable save id',
        check: () => (window as unknown as { reminderIds: string[] }).reminderIds[0],
      })

      if (process.env.PNYX_CAPTURE_REMINDERS && outcome === 'saved') {
        await page.capture({ path: `${process.env.PNYX_CAPTURE_REMINDERS}/pending.png` })
      }

      if (outcome === 'newer-draft') {
        await page.hover({ selector: '.hydra-head strong' })
        await page.shows({
          what: 'task actions close after leaving the task',
          check: () => document.querySelector('.card-menu:not(:popover-open)'),
        })
        await page.hover({ selector: '.card-open' })
        await page.click({ selector: '[aria-label="Remind"]' })
        await page.shows({
          what: 'select the new reminder draft',
          check: () => {
            const field = document.querySelector<HTMLInputElement>('[aria-label="Reminder time"]')
            field?.select()

            return !!field
          },
        })
        await page.type({ text: 'in 3 hours' })
      }

      if (outcome === 'reconnect') {
        await page.shows({
          what: 'disconnect the unconfirmed save',
          check: () => {
            ;(window as unknown as { disconnectReminder(): void }).disconnectReminder()

            return true
          },
        })
        await page.shows({
          what: 'checking retains the preview without failure',
          arg: { when },
          check: ({ when }) =>
            document.querySelector('.save-checking')?.textContent?.includes('Checking') && !document.querySelector('.reminder-editor')
          && document.querySelector('.reminder-label')?.getAttribute('title') === when && !document.body.textContent?.includes('Not sent'),
        })
        await page.shows({
          what: 'the same attempt queued on reconnect',
          check: () => (window as unknown as { reminderIds: string[] }).reminderIds.length > 1,
        })
      }

      await page.shows({
        what: 'release the reminder outcome',
        check: () => {
          ;(window as unknown as { releaseReminder(): void }).releaseReminder()

          return true
        },
      })

      if (outcome === 'refused' || outcome === 'newer-draft') {
        await page.shows({
          what: 'refused preview reverts with a visible reason',
          check: () =>
            !document.querySelector('.reminder-label') && document.querySelector('.notice')?.textContent?.includes('missing-task'),
        })
        const draft = await page.shows({
          what: 'the recovered or newer draft',
          check: () => {
            const field = document.querySelector<HTMLInputElement>('[aria-label="Reminder time"]')

            return field && {
              value: field.value,
              reason: document.querySelector('.reminder-editor [role=alert]')?.textContent ?? '',
            }
          },
        })
        assert.equal(
          draft.value,
          outcome === 'newer-draft' ? 'in 3 hours' : when,
        )

        if (outcome === 'refused') {
          assert.match(
            draft.reason,
            /missing-task/,
          )
          await page.click({
            selector: '.reminder-editor button',
            text: 'Set reminder',
          })
        }
      }

      if (outcome !== 'newer-draft') {
        await page.shows({
          what: 'reminder confirmed in place',
          arg: { when },
          check: ({ when }) =>
            !document.querySelector('[data-pending]') && !document.querySelector('.reminder-editor') && document.querySelector('.reminder-label')?.getAttribute('title') === when,
        })

        if (process.env.PNYX_CAPTURE_REMINDERS) {
          await page.capture({ path: `${process.env.PNYX_CAPTURE_REMINDERS}/clear-pending.png` })
        }

        assert.equal(
          s.task({ key: 'remember' }).reminder?.at,
          when,
        )
        assert.equal(
          s.events().filter(event => event.id === attempt).length,
          1,
        )
        const ids = await page.shows({
          what: 'all deliveries retain the attempt',
          check: () => (window as unknown as { reminderIds: string[] }).reminderIds,
        })
        assert.equal(
          new Set(ids).size,
          1,
        )
      }

      if (outcome === 'saved') {
        if (process.env.PNYX_CAPTURE_REMINDERS) {
          await page.capture({ path: `${process.env.PNYX_CAPTURE_REMINDERS}/confirmed.png` })
        }

        await page.click({ selector: '.card-open' })
        await page.click({ selector: '[aria-label="Remind"]' })
        await page.shows({
          what: 'the clear button fully laid out in the open editor',
          check: () => {
            const card = document.querySelector<HTMLElement>('.card')
            const form = card?.querySelector('.reminder-editor')

            return card && form
              && form.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom
            && !card.getAnimations().some(animation => animation.playState === 'running')
          },
        })
        await page.shows({
          what: 'hold reminder removal',
          check: () => {
            ;(window as unknown as { holdReminder: boolean }).holdReminder = true

            return true
          },
        })
        await page.click({
          selector: '.reminder-editor button',
          text: 'Clear reminder',
        })
        await page.shows({
          what: 'clear closes the editor and removes the reminder immediately',
          check: () => !document.querySelector('.reminder-editor') && !document.querySelector('.reminder-label') && document.querySelector('[data-pending]'),
        })

        if (process.env.PNYX_CAPTURE_REMINDERS) {
          await page.capture({ path: `${process.env.PNYX_CAPTURE_REMINDERS}/clear-pending.png` })
        }

        assert.equal(
          s.task({ key: 'remember' }).reminder?.at,
          when,
        )
        await page.shows({
          what: 'release reminder clearing',
          check: () => {
            ;(window as unknown as { releaseReminder(): void }).releaseReminder()

            return true
          },
        })
        await page.shows({
          what: 'clearing confirmed',
          check: () => !document.querySelector('[data-pending]'),
        })
        assert.equal(
          s.task({ key: 'remember' }).reminder,
          undefined,
        )

        if (process.env.PNYX_CAPTURE_REMINDERS) {
          await page.capture({ path: `${process.env.PNYX_CAPTURE_REMINDERS}/clear-confirmed.png` })
        }
      }

      await page.close()
    },
  )
}
