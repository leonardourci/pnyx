import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserGroup } from './browser.ts'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()
const chrome = browserGroup()

test(
  'card resizing reserves a strip below every clickable control',
  async () => {
    const s = await pnyx.scenario()
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
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Resize this card',
        '--key',
        'resize',
      ],
    })
    await s.owner({
      args: [
        'task',
        'status',
        'resize',
        'working',
        '--note',
        Array.from(
          { length: 30 },
          (
            _,
            index,
          ) =>
            `[Reference ${index + 1}](pnyx-task:${reference.id})`,
        ).join('\n\n'),
      ],
    })
    const task = s.task({ key: 'resize' })
    const card = `.card[data-task="${task.id}"]`
    const page = await chrome.open({ url: `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}/` })
    await page.click({ selector: `${card} .card-state` })
    await page.shows({
      what: 'loaded history with expandable links',
      arg: { card },
      check: ({ card }) => document.querySelector(`${card} .task-updates .show-more`),
    })
    await page.click({ selector: `${card} .show-more` })

    const clearStrip = async () => {
      const layout = await page.shows({
        what: 'the card and its resize strip',
        arg: { card },
        check: ({ card }) => {
          const node = document.querySelector(card)!
          const handle = node.querySelector<HTMLElement>('[aria-label="Resize card"]')!
          const strip = handle.getBoundingClientRect()
          const controls = 'button, a, input, textarea, summary, [role=button]'
          const clickable = [...node.querySelectorAll<HTMLElement>(controls)]

          const underHandle = ({
            rect,
            control,
          }: {
            rect: DOMRect
            control: HTMLElement
          }) => {
            let left = rect.left
            let right = rect.right
            let top = rect.top
            let bottom = rect.bottom

            for (
              let parent = control.parentElement;
              parent && parent !== node;
              parent = parent.parentElement
            ) {
              const css = getComputedStyle(parent)
              const box = parent.getBoundingClientRect()

              if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
                left = Math.max(
                  left,
                  box.left,
                )
                right = Math.min(
                  right,
                  box.right,
                )
              }

              if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
                top = Math.max(
                  top,
                  box.top,
                )
                bottom = Math.min(
                  bottom,
                  box.bottom,
                )
              }
            }

            return Math.max(
              left,
              strip.left,
            ) < Math.min(
              right,
              strip.right,
            )
            && Math.max(
              top,
              strip.top,
            ) < Math.min(
              bottom,
              strip.bottom,
            )
          }

          const underneath = clickable.filter(control => [...control.getClientRects()]
            .some(rect => underHandle({
              rect,
              control,
            }))).map(control => control.outerHTML.slice(
            0,
            160,
          ))

          return {
            contentBottom: Math.max(...[...node.children].filter(child => child !== handle)
              .map(child => child.getBoundingClientRect().bottom)),
            stripTop: strip.top,
            underneath,
            value: Number(handle.getAttribute('aria-valuenow')),
            minimum: Number(handle.getAttribute('aria-valuemin')),
          }
        },
      })
      assert.deepEqual(
        layout.underneath,
        [],
        'the resize handle covers a clickable control',
      )
      assert.ok(
        layout.contentBottom <= layout.stripTop,
        JSON.stringify(layout),
      )

      return layout
    }

    await page.shows({
      what: 'expanded history measured before resizing',
      arg: { card },
      check: ({ card }) => {
        const node = document.querySelector(card)!
        const handle = node.querySelector('[aria-label="Resize card"]')!
        const value = Number(handle.getAttribute('aria-valuenow'))

        return Number(handle.getAttribute('aria-valuemax')) > value + 16
          && Math.abs(node.getBoundingClientRect().height - value) < 1
      },
    })
    const before = await clearStrip()
    assert.ok(
      before.value - before.minimum >= 8,
      'the fixture must allow shrinking',
    )
    await page.click({ selector: `${card} [aria-label="Resize card"]` })
    await page.press({ key: 'ArrowUp' })
    await page.shows({
      what: 'keyboard resize committed an eight-pixel smaller card',
      arg: {
        card,
        height: before.value - 8,
      },
      check: ({
        card,
        height,
      }) => {
        const node = document.querySelector(card)

        return Number(node?.querySelector('[aria-label="Resize card"]')?.getAttribute('aria-valuenow')) === height
        && Math.abs(node!.getBoundingClientRect().height - height) < 1
      },
    })
    await clearStrip()
    await page.reload()
    await page.shows({
      what: 'the resized height survives a reload',
      arg: {
        card,
        height: before.value - 8,
      },
      check: ({
        card,
        height,
      }) => Number(document.querySelector(`${card} [aria-label="Resize card"]`)?.getAttribute('aria-valuenow')) === height,
    })
    await clearStrip()
    await page.close()
  },
)
