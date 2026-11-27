import { beforeAll, expect, test } from 'vitest'
import type { Locator } from 'playwright-core'
import { startOthrys, type Othrys } from '../setup/othrys.ts'
import { openTitan } from './page.ts'

const REPLY = 'I will merge the PR once CI and deslop pass. After that the one-time cleanup runs: it marks 233 old instructions as read where there is proof they were read.'
const MINIMUM_TOUCH_GAP = 24
const LAYOUTS = [
  {
    name: 'wide',
    viewport: {
      width: 1440,
      height: 900,
    },
    touch: false,
  },
  {
    name: 'phone',
    viewport: {
      width: 390,
      height: 844,
    },
    touch: true,
  },
]

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

for (const engine of [
  'chromium',
  'webkit',
] as const) {
  for (const layout of LAYOUTS) {
    test(
      `${engine} ${layout.name}: the bar above the composer and the pill by the selection comment on and quote it, and on touch they keep the passage when the selection drops until a tap lands elsewhere`,
      async () => {
        const titan = await othrys.titan()
        othrys.claude.plan({
          titan: titan.id,
          text: 'Say something',
          reply: REPLY,
        })
        await titan.chat({ text: 'Say something' })
        const page = await openTitan({
          port: othrys.port(),
          titanId: titan.id,
          engine,
          viewport: layout.viewport,
          touch: layout.touch,
        })
        const workspace = page.locator('[data-titan-workspace][data-active=true]')
        const reply = workspace.getByText(
          REPLY,
          { exact: true },
        )
        await reply.waitFor()
        const bar = workspace.getByRole(
          'group',
          { name: 'Selected text' },
        )
        const pill = workspace.locator('.comment-pill')
        const press = ({ target }: { target: Locator }) =>
          layout.touch ? target.tap() : target.click()

        const selectPassage = async ({ words }: { words: string }) => {
          await press({ target: reply })

          await reply.evaluate(
            (
              element,
              chosen,
            ) => {
              const text = [...element.childNodes].find(node => node.textContent?.includes(chosen))
              const selection = getSelection()

              if (!text?.textContent || !selection) {
                throw new Error(`Cannot select ${chosen}`)
              }

              const start = text.textContent.indexOf(chosen)
              selection.setBaseAndExtent(
                text,
                start,
                text,
                start + chosen.length,
              )
            },
            words,
          )
          await expect.poll(() => bar.textContent()).toContain(words)
        }

        const dropTouchSelection = async () => {
          if (layout.touch) {
            await page.evaluate(() => getSelection()?.removeAllRanges())
          }
        }

        await selectPassage({ words: 'the one-time cleanup runs' })

        if (layout.touch) {
          await expect.poll(() => pill.evaluate(element => {
            const selection = getSelection()

            if (!selection?.rangeCount) {
              throw new Error('The reply selection disappeared')
            }

            const selectionBottom = selection.getRangeAt(0).getBoundingClientRect().bottom

            return element.getBoundingClientRect().top - selectionBottom
          })).toBeGreaterThanOrEqual(MINIMUM_TOUCH_GAP)
        }

        await dropTouchSelection()
        const comment = bar.getByRole(
          'button',
          { name: 'Comment' },
        )

        if (layout.touch) {
          await comment.tap()
        } else {
          await comment.hover()
          await page.mouse.down()
        }

        const note = workspace.getByRole(
          'textbox',
          {
            name: 'Comment on selected text',
            exact: true,
          },
        )
        await expect.poll(() => note.evaluate(field => field.contains(document.activeElement)
          || field === document.activeElement)).toBe(true)

        if (!layout.touch) {
          await page.mouse.up()
        }

        await page.keyboard.type('which four stay unread')
        expect(await note.textContent()).toBe('which four stay unread')
        expect(await workspace.getByRole(
          'group',
          { name: 'Comment 1' },
        ).textContent()).toContain('the one-time cleanup runs')
        await bar.waitFor({ state: 'detached' })

        await selectPassage({ words: '233 old instructions' })
        await dropTouchSelection()
        const quote = pill.getByRole(
          'button',
          { name: 'Quote selection' },
        )

        if (layout.touch) {
          await quote.tap()
        } else {
          await quote.press('Space')
        }

        const composer = workspace.getByRole(
          'textbox',
          {
            name: 'Reply to Titan',
            exact: true,
          },
        )
        await expect.poll(() => composer.textContent()).toContain('233 old instructions')
        await bar.waitFor({ state: 'detached' })

        await selectPassage({ words: 'proof they were read' })
        await dropTouchSelection()
        await bar.getByRole(
          'button',
          { name: 'Comment' },
        ).press('Escape')
        await pill.waitFor({ state: 'detached' })

        await selectPassage({ words: 'proof they were read' })
        await dropTouchSelection()
        await press({
          target: workspace.getByText(
            'Say something',
            { exact: true },
          ),
        })
        await bar.waitFor({ state: 'detached' })
        await pill.waitFor({ state: 'detached' })
      },
    )
  }
}
