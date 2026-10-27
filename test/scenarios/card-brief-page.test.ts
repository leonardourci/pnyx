import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

const until = async ({
  what,
  check,
}: {
  what: string
  check(): boolean
}) => {
  for (let tries = 0; tries < 100; tries++) {
    if (check()) {
      return
    }

    await sleep(100)
  }

  assert.fail(`timed out waiting for ${what}`)
}

test(
  'the brief folds out of the title; Space folds it, Enter opens the task and Mod+E edits',
  async () => {
    const s = await pnyx.scenario()
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Ship the layout',
        '--key',
        'ship',
        '--brief',
        '**Ready** to ship',
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Bare task',
        '--key',
        'bare',
      ],
    })
    const card = `.card[data-task="${s.task({ key: 'ship' }).id}"]`
    const bare = `.card[data-task="${s.task({ key: 'bare' }).id}"]`
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.shows({
      what: 'connected cards with folded briefs',
      arg: { card },
      check: ({ card }) => document.querySelector('[data-connected=true]')
        && document.querySelector(`${card} .card-brief`)?.hasAttribute('hidden'),
    })

    await page.click({ selector: `${card} .card-open` })
    await page.shows({
      what: 'the brief under the title, with the task still closed',
      arg: { card },
      check: ({ card }) => {
        const element = document.querySelector(card)!
        const title = element.querySelector('.card-open')!
        const brief = element.querySelector<HTMLElement>('.card-brief')!

        return title.getAttribute('aria-expanded') === 'true' && title.getAttribute('aria-controls') === brief.id
          && !brief.hidden && brief.querySelector('.markdown strong')?.textContent === 'Ready'
          && !element.classList.contains('selected')
      },
    })
    await page.click({ selector: `${card} .card-open` })
    await page.shows({
      what: 'a second click folds the brief away',
      arg: { card },
      check: ({ card }) => document.querySelector(`${card} .card-open`)?.getAttribute('aria-expanded') === 'false'
        && document.querySelector(`${card} .card-brief`)?.hasAttribute('hidden'),
    })

    await page.press({ key: 'Space' })
    await page.shows({
      what: 'Space on the focused title shows the brief',
      arg: { card },
      check: ({ card }) => document.activeElement === document.querySelector(`${card} .card-open`)
        && !document.querySelector(`${card} .card-brief`)?.hasAttribute('hidden'),
    })
    await page.press({ key: 'Space' })
    await page.shows({
      what: 'Space again folds it',
      arg: { card },
      check: ({ card }) => document.querySelector(`${card} .card-brief`)?.hasAttribute('hidden'),
    })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'Enter opens the task without unfolding the brief',
      arg: { card },
      check: ({ card }) => document.querySelector(card)?.classList.contains('selected')
        && document.querySelector(`${card} .card-brief`)?.hasAttribute('hidden'),
    })

    await page.click({ selector: `${bare} .card-open` })
    await page.shows({
      what: 'a task without a brief says so',
      arg: { bare },
      check: ({ bare }) => document.querySelector(`${bare} .card-brief:not([hidden])`)?.textContent === 'No brief yet. The pencil adds one.',
    })

    await page.shows({
      what: 'Mod+E on the focused title opens the editor',
      arg: { card },
      check: ({ card }) => {
        const title = document.querySelector<HTMLElement>(`${card} .card-open`)

        if (title) {
          const mac = /Mac|iPhone|iPad/.test(navigator.platform)
          title.focus()
          title.dispatchEvent(new KeyboardEvent(
            'keydown',
            {
              key: 'e',
              metaKey: mac,
              ctrlKey: !mac,
              bubbles: true,
              cancelable: true,
            },
          ))
        }

        return document.activeElement?.matches(`${card} .task-editor [aria-label="Task title"]`)
      },
    })
    await page.press({ key: 'Escape' })
    await page.shows({
      what: 'Escape closes the editor and keeps the task open',
      arg: { card },
      check: ({ card }) => !document.querySelector('.task-editor')
        && document.querySelector(`${card} .card-open`)?.textContent === 'Ship the layout'
        && document.querySelector(card)?.classList.contains('selected'),
    })
  },
)

for (const outcome of [
  'saved',
  'refused',
]) {
  test(
    `the pencil edits the title and brief together, shown before the server answers (${outcome})`,
    async () => {
      const s = await pnyx.scenario()
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          'Ship the layout',
          '--key',
          'ship',
          '--brief',
          'Old brief',
        ],
      })
      const card = `.card[data-task="${s.task({ key: 'ship' }).id}"]`
      const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
      await page.shows({
        what: 'connected, then hold the title and brief saves',
        arg: { outcome },
        check: ({ outcome }) => {
          if (!document.querySelector('[data-connected=true]')) {
            return false
          }

          const send = WebSocket.prototype.send
          const held: (() => void)[] = []
          const control = window as unknown as {
            held: (() => void)[]
            released: boolean
            release(): void
          }
          control.held = held
          control.released = false

          // The page sends one edit at a time, so the brief follows once the title is answered.
          control.release = () => {
            control.released = true; held.splice(0).forEach(run => run())
          }

          // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
          WebSocket.prototype.send = function(data) {
            const message = JSON.parse(String(data))

            if (message.name === 'task' && [
              'rename',
              'brief',
            ].includes(message.args[0])) {
              const args = [...message.args]

              if (outcome === 'refused') {
                args[1] = 'missing-task'
              }

              const run = () => send.call(
                this,
                JSON.stringify({
                  ...message,
                  args,
                }),
              )

              if (control.released) {
                run()
              } else {
                held.push(run)
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

      await page.shows({
        what: 'the pencil opens the task with the title focused',
        arg: { card },
        check: ({ card }) => {
          if (!document.querySelector('.task-editor')) {
            document.querySelector<HTMLButtonElement>(`${card} [aria-label="Edit title and brief"]`)?.click()
          }

          const field = document.querySelector<HTMLInputElement>(`${card} .task-editor [aria-label="Task title"]`)

          return document.querySelector(card)?.classList.contains('selected') && document.activeElement === field
            && field.value === 'Ship the layout'
            && document.querySelector<HTMLTextAreaElement>(`${card} .task-editor [aria-label="Brief"]`)?.value === 'Old brief'
        },
      })
      await page.type({ text: ' now' })
      await page.press({ key: 'Enter' })
      await page.shows({
        what: 'Enter in the title moves to the brief',
        arg: { card },
        check: ({ card }) => {
          const field = document.querySelector<HTMLTextAreaElement>(`${card} .task-editor [aria-label="Brief"]`)

          if (document.activeElement !== field) {
            return false
          }

          field.select()

          return true
        },
      })
      await page.type({ text: 'New brief' })
      await page.shows({
        what: 'Mod+Enter shows both edits at once, before the server answers',
        arg: { card },
        check: ({ card }) => {
          const field = document.querySelector<HTMLTextAreaElement>(`${card} .task-editor [aria-label="Brief"]`)

          if (field) {
            const mac = /Mac|iPhone|iPad/.test(navigator.platform)
            field.dispatchEvent(new KeyboardEvent(
              'keydown',
              {
                key: 'Enter',
                metaKey: mac,
                ctrlKey: !mac,
                bubbles: true,
                cancelable: true,
              },
            ))
          }

          const control = window as unknown as { held: unknown[] }

          return !document.querySelector('.task-editor') && control.held.length > 0
            && document.querySelector(`${card} .card-open`)?.textContent === 'Ship the layout now'
            && document.querySelector(`${card} .card-brief:not([hidden])`)?.textContent === 'New brief'
        },
      })
      assert.equal(
        s.task({ key: 'ship' }).title,
        'Ship the layout',
      )
      await page.shows({
        what: 'release the held saves',
        check: () => {
          (window as unknown as { release(): void }).release()

          return true
        },
      })

      if (outcome === 'saved') {
        await until({
          what: 'both edits saved',
          check: () => s.task({ key: 'ship' }).title === 'Ship the layout now' && s.task({ key: 'ship' }).brief === 'New brief',
        })
        await page.shows({
          what: 'the confirmed edits stay in place',
          arg: { card },
          check: ({ card }) => !document.querySelector('.task-editor')
            && document.querySelector(`${card} .card-open`)?.textContent === 'Ship the layout now'
            && document.querySelector(`${card} .card-brief`)?.textContent === 'New brief',
        })

        return
      }

      await page.shows({
        what: 'the refusal reopens the editor with the drafts',
        arg: { card },
        check: ({ card }) => document.querySelector<HTMLInputElement>(`${card} .task-editor [aria-label="Task title"]`)?.value === 'Ship the layout now'
          && document.querySelector<HTMLTextAreaElement>(`${card} .task-editor [aria-label="Brief"]`)?.value === 'New brief',
      })
      await page.press({ key: 'Escape' })
      await page.shows({
        what: 'the refused edits rolled back',
        arg: { card },
        check: ({ card }) => document.querySelector(`${card} .card-open`)?.textContent === 'Ship the layout'
          && document.querySelector(`${card} .card-brief`)?.textContent === 'Old brief',
      })
      assert.equal(
        s.task({ key: 'ship' }).brief,
        'Old brief',
      )
    },
  )
}
