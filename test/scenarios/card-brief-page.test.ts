import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

type Page = Awaited<ReturnType<typeof chrome.open>>

// Records the task commands the page sends; with hold set, they wait until release().
const watchSends = ({
  page,
  hold,
  refuse,
}: {
  page: Page
  hold: boolean
  refuse: boolean
}) => page.shows({
  what: 'connected, then watch task edits sent to the server',
  arg: {
    hold,
    refuse,
  },
  check: ({
    hold,
    refuse,
  }) => {
    if (!document.querySelector('[data-connected=true]')) {
      return false
    }

    const send = WebSocket.prototype.send
    const control = window as unknown as {
      sent: string[]
      held: (() => void)[]
      released: boolean
      release(): void
    }
    control.sent = []
    control.held = []
    control.released = !hold

    // The page sends one edit at a time, so the brief follows once the title is answered.
    control.release = () => {
      control.released = true; control.held.splice(0).forEach(run => run())
    }

    // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
    WebSocket.prototype.send = function(data) {
      const message = JSON.parse(String(data))

      if (message.name !== 'task' || ![
        'rename',
        'brief',
      ].includes(message.args[0])) {
        send.call(
          this,
          data,
        )

        return
      }

      control.sent.push(message.args[0])
      const args = [...message.args]

      if (refuse) {
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
        control.held.push(run)
      }
    }

    return true
  },
})

const editorOpen = ({
  page,
  card,
}: {
  page: Page
  card: string
}) => page.shows({
  what: 'the task open with the editor focused on its title, after the open settles',
  arg: { card },
  check: ({ card }) => document.querySelector(card)?.classList.contains('selected')
    && document.querySelector(`${card} .task-updates`)
    && document.activeElement === document.querySelector(`${card} .task-editor [aria-label="Task title"]`),
})

test(
  'a card title toggles its brief on click or Space, Enter opens the task, and F2 or Mod+E edit it',
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
    await watchSends({
      page,
      hold: false,
      refuse: false,
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

    await page.shows({
      what: 'the card drags by its title but not from its pencil',
      arg: { card },
      check: ({ card }) => {
        const element = document.querySelector<HTMLElement>(card)!

        const drag = ({ from }: { from: Element }) => {
          const event = new DragEvent(
            'dragstart',
            {
              bubbles: true,
              cancelable: true,
              dataTransfer: new DataTransfer(),
            },
          )
          from.dispatchEvent(event)
          element.dispatchEvent(new DragEvent(
            'dragend',
            { bubbles: true },
          ))

          return event
        }

        const title = drag({ from: element.querySelector('.card-open')! })
        const pencil = drag({ from: element.querySelector('[aria-label="Edit title and brief"]')! })

        return element.draggable && !title.defaultPrevented && title.dataTransfer?.getData('application/pnyx-task') !== ''
          && pencil.defaultPrevented
      },
    })

    await page.press({ key: 'F2' })
    await editorOpen({
      page,
      card,
    })
    await page.shows({
      what: 'the open card is not draggable while editing',
      arg: { card },
      check: ({ card }) => !document.querySelector<HTMLElement>(card)?.draggable,
    })
    await page.type({ text: ' later' })
    await page.press({ key: 'Escape' })
    await page.shows({
      what: 'Escape drops the typed title, keeps the task open and returns focus to the title',
      arg: { card },
      check: ({ card }) => !document.querySelector('.task-editor')
        && document.activeElement === document.querySelector(`${card} .card-open`)
        && document.querySelector(`${card} .card-open`)?.textContent === 'Ship the layout'
        && document.querySelector(card)?.classList.contains('selected'),
    })
    await page.press({
      key: 'KeyE',
      mod: true,
    })
    await page.shows({
      what: 'Mod+E opens the editor',
      arg: { card },
      check: ({ card }) => document.activeElement === document.querySelector(`${card} .task-editor [aria-label="Task title"]`),
    })
    await page.type({ text: ' later' })
    await page.click({
      selector: `${card} .task-editor button`,
      text: 'Cancel',
    })
    await page.shows({
      what: 'Cancel drops the typed title and returns focus to the title',
      arg: { card },
      check: ({ card }) => !document.querySelector('.task-editor')
        && document.activeElement === document.querySelector(`${card} .card-open`)
        && document.querySelector(`${card} .card-open`)?.textContent === 'Ship the layout',
    })
    assert.deepEqual(
      await page.evaluate({ expression: '(window).sent' }),
      [],
    )

    await page.evaluate({ expression: `document.querySelector('${bare} .card-open').focus()` })
    await page.press({ key: 'Space' })
    await page.shows({
      what: 'a task without a brief says so',
      arg: { bare },
      check: ({ bare }) => document.querySelector(`${bare} .card-brief:not([hidden])`)?.textContent === 'No brief yet. The pencil adds one.',
    })
    await page.press({ key: 'Enter' })
    await page.shows({
      what: 'Enter on the title opens the task',
      arg: { bare },
      check: ({ bare }) => document.querySelector(bare)?.classList.contains('selected'),
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
      await watchSends({
        page,
        hold: true,
        refuse: outcome === 'refused',
      })
      await page.hover({ selector: `${card} .card-open` })
      await page.click({ selector: `${card} [aria-label="Edit title and brief"]` })
      await editorOpen({
        page,
        card,
      })
      await page.shows({
        what: 'both fields filled in',
        arg: { card },
        check: ({ card }) => document.querySelector<HTMLInputElement>(`${card} .task-editor [aria-label="Task title"]`)?.value === 'Ship the layout'
          && document.querySelector<HTMLTextAreaElement>(`${card} .task-editor [aria-label="Brief"]`)?.value === 'Old brief',
      })
      await page.type({ text: ' now' })
      await page.press({ key: 'Enter' })
      await page.shows({
        what: 'Enter in the title moves to the brief',
        arg: { card },
        check: ({ card }) => {
          const field = document.querySelector<HTMLTextAreaElement>(`${card} .task-editor [aria-label="Brief"]`)

          if (!field || document.activeElement !== field) {
            return false
          }

          field.select()

          return true
        },
      })
      await page.type({ text: 'New brief' })
      await page.press({
        key: 'Enter',
        mod: true,
      })
      await page.shows({
        what: 'Mod+Enter shows both edits at once, before the server answers',
        arg: { card },
        check: ({ card }) => !document.querySelector('.task-editor')
          && (window as unknown as { held: unknown[] }).held.length > 0
          && document.activeElement === document.querySelector(`${card} .card-open`)
          && document.querySelector(`${card} .card-open`)?.textContent === 'Ship the layout now'
          && document.querySelector(`${card} .card-brief:not([hidden])`)?.textContent === 'New brief',
      })
      assert.equal(
        s.task({ key: 'ship' }).title,
        'Ship the layout',
      )
      await page.evaluate({ expression: '(window).release()' })

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
        what: 'the refusal reopens the editor with the drafts and shows the reason',
        arg: { card },
        check: ({ card }) => document.querySelector<HTMLInputElement>(`${card} .task-editor [aria-label="Task title"]`)?.value === 'Ship the layout now'
          && document.querySelector<HTMLTextAreaElement>(`${card} .task-editor [aria-label="Brief"]`)?.value === 'New brief'
          && document.querySelector('.notice[role=status]')?.textContent?.includes('missing-task'),
      })
      await page.press({ key: 'Escape' })
      await page.shows({
        what: 'the refused edits rolled back',
        arg: { card },
        check: ({ card }) => document.querySelector(`${card} .card-open`)?.textContent === 'Ship the layout'
          && document.querySelector(`${card} .card-brief`)?.textContent === 'Old brief',
      })
      assert.equal(
        s.task({ key: 'ship' }).title,
        'Ship the layout',
      )
      assert.equal(
        s.task({ key: 'ship' }).brief,
        'Old brief',
      )
    },
  )
}

test(
  'only changed fields are sent, and a blank title keeps the saved one',
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
      ],
    })
    const card = `.card[data-task="${s.task({ key: 'ship' }).id}"]`
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await watchSends({
      page,
      hold: false,
      refuse: false,
    })
    await page.hover({ selector: `${card} .card-open` })
    await page.click({ selector: `${card} [aria-label="Edit title and brief"]` })
    await editorOpen({
      page,
      card,
    })
    await page.shows({
      what: 'the title selected',
      arg: { card },
      check: ({ card }) => {
        document.querySelector<HTMLInputElement>(`${card} .task-editor [aria-label="Task title"]`)?.select()

        return true
      },
    })
    await page.type({ text: '   ' })
    await page.press({ key: 'Enter' })
    await page.type({ text: 'Only the brief' })
    await page.press({
      key: 'Enter',
      mod: true,
    })
    await until({
      what: 'the brief saved',
      check: () => s.task({ key: 'ship' }).brief === 'Only the brief',
    })
    assert.equal(
      s.task({ key: 'ship' }).title,
      'Ship the layout',
    )
    assert.deepEqual(
      await page.evaluate({ expression: '(window).sent' }),
      ['brief'],
    )
    await page.shows({
      what: 'the card keeps its title',
      arg: { card },
      check: ({ card }) => document.querySelector(`${card} .card-open`)?.textContent === 'Ship the layout',
    })
  },
)

test(
  'editing is unavailable while the page is disconnected',
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
      ],
    })
    const card = `.card[data-task="${s.task({ key: 'ship' }).id}"]`
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.shows({
      what: 'connected',
      check: () => document.querySelector('[data-connected=true]'),
    })
    await page.click({ selector: `${card} .card-open` })
    await pnyx.restart({
      whileStopped: async () => {
        await page.shows({
          what: 'the page disconnected with the pencil disabled',
          arg: { card },
          check: ({ card }) => document.querySelector('[data-connected=false]')
            && document.querySelector<HTMLButtonElement>(`${card} [aria-label="Edit title and brief"]`)?.disabled,
        })
        await page.press({ key: 'F2' })
        await page.press({
          key: 'KeyE',
          mod: true,
        })
        await page.shows({
          what: 'no editor opened while disconnected',
          arg: { card },
          check: ({ card }) => !document.querySelector('.task-editor')
            && document.activeElement === document.querySelector(`${card} .card-open`),
        })
      },
    })
  },
)
