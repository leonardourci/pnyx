/* eslint-disable pnyx/object-params -- Playwright owns evaluation callbacks. */
import { beforeAll, expect, test } from 'vitest'
import type { Locator, Page } from 'playwright-core'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

const LINE = 'A whole reply line remains available.'
let pnyx: Pnyx
beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

async function conversation() {
  const hydra = await pnyx.hydra()
  await hydra.owner({
    args: [
      'task',
      'create',
      '--key',
      'selection',
      '--title',
      'Selection task',
    ],
  })
  const task = await hydra.task({ key: 'selection' })
  pnyx.claude.plan({
    hydra: hydra.id,
    text: 'Show selectable text',
    reply: `${LINE}\n\nRead [Reference guide](https://example.invalid/guide) and [@Selection task](pnyx-task:${task.id}) before continuing.`,
  })
  const session = await hydra.chat({ text: 'Show selectable text' })
  await until({
    what: 'the selection reply lands',
    check: () => session.answered === 1,
  })
  const page = await openHydra({
    port: pnyx.port(),
    hydraId: hydra.id,
  })
  const messages = page.locator(`[data-hydra-workspace="${hydra.id}"] .hydra-chat .messages`)
  await messages.getByText(
    LINE,
    { exact: true },
  ).waitFor()
  await page.evaluate(() => document.fonts.ready)

  return {
    page,
    messages,
  }
}

async function selectCharacters({
  page,
  target,
  from,
  to,
}: {
  page: Page
  target: Locator
  from: number
  to: number
}) {
  const points = await target.evaluate(
    (
      element,
      {
        from,
        to,
      },
    ) => {
      window.getSelection()?.removeAllRanges()
      const text = element.firstChild!
      const range = document.createRange()
      range.setStart(
        text,
        from,
      ); range.collapse(true)
      const start = range.getBoundingClientRect()
      range.setStart(
        text,
        to,
      ); range.collapse(true)
      const end = range.getBoundingClientRect()

      return {
        start: start.x,
        end: end.x,
        y: start.y + start.height / 2,
      }
    },
    {
      from,
      to,
    },
  )
  await page.mouse.move(
    points.start + 0.1,
    points.y,
  )
  await page.mouse.down()
  await page.mouse.move(
    points.end + 0.1,
    points.y,
    { steps: 12 },
  )
  await page.mouse.up()

  return page.evaluate(() => window.getSelection()?.toString())
}

test(
  'a complete reply line selected at its block boundaries offers a comment',
  async () => {
    const {
      page,
      messages,
    } = await conversation()

    try {
      await messages.getByText(
        LINE,
        { exact: true },
      ).evaluate(element => {
        const range = document.createRange()
        range.selectNode(element.closest('[data-message-block]')!)
        const selection = window.getSelection()!
        selection.removeAllRanges(); selection.addRange(range)
      })
      expect((await page.evaluate(() => window.getSelection()?.toString()))?.trim()).toBe(LINE)
      const comment = messages.getByRole(
        'button',
        {
          name: 'Comment on selection',
          exact: true,
        },
      )
      await comment.click()
      await messages.getByRole(
        'textbox',
        {
          name: 'Comment on selected text',
          exact: true,
        },
      ).waitFor()
      expect(await messages.locator('.comment-quote mark').textContent()).toBe(LINE)
    } finally {
      await page.context().close()
    }
  },
)

test(
  'transcript content cancels native link dragging',
  async () => {
    const {
      page,
      messages,
    } = await conversation()

    try {
      const link = messages.getByRole(
        'link',
        {
          name: 'Reference guide',
          exact: true,
        },
      )
      expect(await link.evaluate(element => element.dispatchEvent(new DragEvent(
        'dragstart',
        {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
        },
      )))).toBe(false)
      const bounds = (await link.boundingBox())!
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      )
      await page.mouse.down()
      await page.mouse.move(
        bounds.x + bounds.width / 2 + 100,
        bounds.y + bounds.height + 20,
        { steps: 16 },
      )
      await page.mouse.up()
      expect(await link.count()).toBe(1)
      expect(await page.locator('.physical-ghost').count()).toBe(0)
    } finally {
      await page.context().close()
    }
  },
)

test(
  'partial task-reference and link text stays selectable without opening either',
  async () => {
    const {
      page,
      messages,
    } = await conversation()

    try {
      expect(await selectCharacters({
        page,
        target: messages.locator('.task-reference-title'),
        from: 2,
        to: 7,
      })).toBe('lecti')
      expect(new URL(page.url()).searchParams.has('task')).toBe(false)
      expect(await messages.getByRole(
        'button',
        {
          name: 'Comment on selection',
          exact: true,
        },
      ).count()).toBe(1)
      expect(await selectCharacters({
        page,
        target: messages.getByRole(
          'link',
          {
            name: 'Reference guide',
            exact: true,
          },
        ),
        from: 2,
        to: 9,
      })).toBe('ference')
      expect(new URL(page.url()).searchParams.has('task')).toBe(false)
    } finally {
      await page.context().close()
    }
  },
)
