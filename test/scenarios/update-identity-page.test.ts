import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()
type Scenario = Awaited<ReturnType<typeof pnyx.scenario>>
const openHydra = ({ s }: { s: Scenario }) => chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })

const startedTask = async ({ s }: { s: Scenario }) => {
  const folder = s.folder({ name: 'web-app' })
  await s.owner({
    args: [
      'task',
      'create',
      '--title',
      'Ship the layout',
      '--key',
      'ship',
      '--folder',
      folder,
    ],
  })
  await s.owner({
    args: [
      'task',
      'start',
      'ship',
    ],
  })
  const worker = s.as({ agent: await s.agent({ cwd: folder }) })
  await until({
    what: 'the worker to finish its opening turn',
    check: () => s.task({ key: 'ship' }).sessionActivity === 'finished',
  })

  return {
    folder,
    worker,
  }
}

test(
  'update rows survive delayed history and worker regrouping',
  async () => {
    const s = await pnyx.scenario()
    const { worker } = await startedTask({ s })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Reference task',
        '--key',
        'reference',
      ],
    })
    const reference = s.task({ key: 'reference' })
    const task = s.task({ key: 'ship' })
    const card = `.card[data-task="${task.id}"]`
    const markdown = `**Ready for review**

- First item
- Second item

\`\`\`sh
pnpm run lint
\`\`\`

| Check | Result |
| --- | --- |
| Layout | Ready |

[Reference task](pnyx-task:${reference.id})

End of the long update.`
    await s.owner({
      args: [
        'task',
        'brief',
        'ship',
        '--brief',
        markdown,
      ],
    })
    await worker.run({
      args: [
        'task',
        'status',
        'ship',
        'working',
        '--note',
        markdown,
      ],
    })
    await s.owner({
      args: [
        'reply',
        'ship',
        '--text',
        '**Earlier instructions**\n\n' + 'Keep the unrelated update folded. '.repeat(30),
      ],
    })
    const page = await openHydra({ s })
    await page.shows({
      what: 'connected before holding update history',
      check: () => document.querySelector('[data-connected=true]'),
    })
    await page.shows({
      what: 'hold the history request',
      arg: { id: task.id },
      check: ({ id }) => {
        const control = window as unknown as {
          updateIdentity: {
            held: number
            nodes?: Element[]
            removed: number
            release(): void
            stop(): void
          }
        }
        const state: typeof control.updateIdentity = control.updateIdentity = {
          held: 0,
          removed: 0,
          release: () => {},
          stop: () => {},
        }
        const send = WebSocket.prototype.send
        const held: {
          socket: WebSocket
          data: Parameters<WebSocket['send']>[0]
        }[] = []

        // eslint-disable-next-line pnyx/object-params -- WebSocket.send takes one payload.
        WebSocket.prototype.send = function(data) {
          const message = JSON.parse(String(data))

          if (message.name === 'history' && message.args.includes('--updates') && message.args.includes(id)) {
            held.push({
              socket: this,
              data,
            }); state.held++
          } else {
            send.call(
              this,
              data,
            )
          }
        }

        const observer = new MutationObserver(records => {
          for (const record of records) {
            for (const removed of record.removedNodes) {
              if (state.nodes?.some(node => removed === node || removed.contains(node))) {
                state.removed++
              }
            }
          }
        })
        observer.observe(
          document.body,
          {
            childList: true,
            subtree: true,
          },
        )

        state.release = () => {
          WebSocket.prototype.send = send

          for (const request of held) {
            send.call(
              request.socket,
              request.data,
            )
          }
        }

        state.stop = () => observer.disconnect()

        return true
      },
    })
    await page.click({ selector: `${card} .card-state` })
    await page.click({
      selector: `${card} .task-updates :is(summary, button)`,
      text: 'worker updates',
    })
    const control = await page.shows({
      what: 'formatted update clamped to three compact lines',
      arg: { card },
      check: ({ card }) => {
        const row = [...document.querySelectorAll(`${card} .update-line`)]
          .find(row => row.querySelector('strong')?.textContent === 'Ready for review')
        const preview = row?.querySelector<HTMLElement>('.text-preview')

        const button = row?.querySelector('.show-more')

        const state = (window as unknown as {
          updateIdentity: {
            held: number
            nodes?: Element[]
          }
        }).updateIdentity
        const content = row?.querySelector('.collapsible-text > div')
        const node = document.querySelector(card)

        if (!state.held || !node || !row || !button || !content) {
          return false
        }

        state.nodes = [
          node,
          row,
          button,
          content,
        ]

        return preview && preview.scrollHeight > preview.clientHeight
          && getComputedStyle(preview.querySelector('.markdown')!).fontSize === '12px'
          && button?.getAttribute('aria-expanded') === 'false'
          && button.getAttribute('aria-controls')
      },
    })
    const toggle = `${card} .show-more[aria-controls=${JSON.stringify(control)}]`
    await page.click({ selector: toggle })
    await page.shows({
      what: 'the full Markdown update after Show more',
      arg: { control },
      check: ({ control }) => {
        const expanded = document.getElementById(control)?.parentElement

        return expanded?.querySelector('.show-more')?.getAttribute('aria-expanded') === 'true'
          && expanded.querySelector('strong')?.textContent === 'Ready for review'
          && expanded.querySelector('li')?.textContent === 'First item'
          && expanded.querySelector('pre code')?.textContent?.includes('pnpm run lint')
          && expanded.querySelector('td')?.textContent === 'Layout'
          && expanded.querySelector('[role=button].task-reference')?.textContent?.includes('Reference task')
          && !expanded.querySelector('.text-preview')
      },
    })
    await page.shows({
      what: 'release the held update history',
      check: () => {
        ;(window as unknown as { updateIdentity: { release(): void } }).updateIdentity.release()

        return true
      },
    })
    const identity = await page.shows({
      what: 'history reconciled around the existing update',
      arg: { card },
      check: ({ card }) => {
        const state = (window as unknown as {
          updateIdentity: {
            nodes: Element[]
            removed: number
            stop(): void
          }
        }).updateIdentity
        const node = document.querySelector(card)

        if (node?.querySelector('.task-updates [role=status]') || !node?.querySelector('.task-updates')?.textContent?.includes('Earlier instructions')) {
          return false
        }

        const row = [...node.querySelectorAll('.update-line')].find(row => row.querySelector('strong')?.textContent === 'Ready for review')
        const button = row?.querySelector('.show-more')
        const content = row?.querySelector('.collapsible-text > div')
        state.stop()

        return {
          same: [
            node,
            row,
            button,
            content,
          ].every((
            element,
            index,
          ) => element === state.nodes[index]),
          connected: state.nodes.every(node => node.isConnected),
          removed: state.removed,
          control: button?.getAttribute('aria-controls'),
          expanded: button?.getAttribute('aria-expanded'),
        }
      },
    })
    assert.deepEqual(
      identity,
      {
        same: true,
        connected: true,
        removed: 0,
        control,
        expanded: 'true',
      },
    )
    await page.click({ selector: toggle })
    await page.shows({
      what: 'Show less restores the preview',
      arg: { control },
      check: ({ control }) => {
        const content = document.getElementById(control)

        return content?.classList.contains('text-preview')
          && content.parentElement?.querySelector('.show-more')?.getAttribute('aria-expanded') === 'false'
      },
    })
    await s.owner({
      args: [
        'task',
        'brief',
        'ship',
        '--brief',
        markdown + '\n\nUpdated instructions.',
      ],
    })
    await worker.run({
      args: [
        'task',
        'status',
        'ship',
        'working',
        '--note',
        markdown.replace(
          'Ready for review',
          'Kept while grouping',
        ),
      ],
    })
    const groupedControl = await page.shows({
      what: 'the new single worker entry',
      arg: { card },
      check: ({ card }) => {
        const row = [...document.querySelectorAll(`${card} .update-line`)].find(row => row.querySelector('strong')?.textContent === 'Kept while grouping')
        const button = row?.querySelector('.show-more')
        const content = row?.querySelector('.collapsible-text > div')

        if (!row || !button || !content || !button.getClientRects().length) {
          return false
        }

        (window as unknown as { groupedIdentity: Element[] }).groupedIdentity = [
          row,
          button,
          content,
        ]

        return button.getAttribute('aria-controls')
      },
    })
    const groupedToggle = `${card} .show-more[aria-controls=${JSON.stringify(groupedControl)}]`
    await page.click({ selector: groupedToggle })
    await worker.run({
      args: [
        'task',
        'status',
        'ship',
        'working',
        '--note',
        'More progress after the long update.',
      ],
    })
    const grouped = await page.shows({
      what: 'the existing entry reconciled into a worker group',
      arg: { card },
      check: ({ card }) => {
        const row = [...document.querySelectorAll(`${card} .update-line`)].find(row => row.querySelector('strong')?.textContent === 'Kept while grouping')
        const group = row?.closest('[data-update]')

        if (!group?.querySelector('.update-group-toggle[aria-expanded=true]')) {
          return false
        }

        const button = row?.querySelector('.show-more')
        const content = row?.querySelector('.collapsible-text > div')
        const before = (window as unknown as { groupedIdentity: Element[] }).groupedIdentity

        return {
          same: [
            row,
            button,
            content,
          ].every((
            element,
            index,
          ) => element === before[index]),
          connected: before.every(node => node.isConnected),
          expanded: button?.getAttribute('aria-expanded'),
        }
      },
    })
    assert.deepEqual(
      grouped,
      {
        same: true,
        connected: true,
        expanded: 'true',
      },
    )
    await page.close()
  },
)
