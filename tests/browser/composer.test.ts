import { beforeAll, expect, test } from 'vitest'
import type { Page } from 'playwright-core'
import { startOthrys, type Othrys } from '../setup/othrys.ts'
import { openTitan } from './page.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

const PHONE = {
  width: 390,
  height: 844,
}

const composerOf = ({ page }: { page: Page }) => page.locator('[data-titan-workspace][data-active=true]').getByRole(
  'textbox',
  {
    name: 'Reply to Titan',
    exact: true,
  },
)

const skill = ({
  name,
  project,
}: {
  name: string
  project?: string
}) => `[@${name}](othrys-skill:${encodeURIComponent(JSON.stringify({
  name,
  project,
}))})`

test(
  'the caret is drawn right after the last character typed when chips come before it, wide and at phone size',
  async () => {
    const titan = await othrys.titan()
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const composer = composerOf({ page })
    await composer.fill([
      'please check',
      '[@Fix the slow starts](othrys-task:task-1)',
      'and run',
      skill({
        name: 'othrys-report-progress',
        project: 'othrys',
      }),
      'then the [@Review](othrys-column:review) column with',
      skill({ name: 'inscribe' }),
      'and [image: /tmp/shot.png] before we ship the whole thing to everybody waiting on it, then',
    ].join(' '))
    await page.keyboard.type(' something you know')

    const caretAfterLastLetter = () => composer.evaluate(field => {
      const caret = getSelection()!.getRangeAt(0).getBoundingClientRect()
      const text = [...field.childNodes].filter(node => node instanceof Text).at(-1)!
      const letter = document.createRange()
      letter.setStart(
        text,
        text.data.length - 1,
      )
      letter.setEnd(
        text,
        text.data.length,
      )
      const shown = letter.getBoundingClientRect()

      return {
        letter: letter.toString(),
        besideIt: Math.abs(caret.left - shown.right) < 1,
        sameLine: Math.abs(caret.top - shown.top) < 1 && Math.abs(caret.bottom - shown.bottom) < 1,
      }
    })
    const expected = {
      letter: 'w',
      besideIt: true,
      sameLine: true,
    }

    expect(await caretAfterLastLetter()).toEqual(expected)
    await page.setViewportSize(PHONE)
    expect(await caretAfterLastLetter()).toEqual(expected)
  },
)

test(
  'arrows step over a chip in one press each way, Shift+arrow selects it whole, and Backspace or Delete beside it removes it',
  async () => {
    const titan = await othrys.titan()
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const composer = composerOf({ page })

    // The text around the caret, with | at the caret, [ ] around a selection and # for each chip.
    const caret = () => composer.evaluate(field => {
      const selection = getSelection()!

      const shown = ({
        node,
        offset,
      }: {
        node: Node
        offset: number
      }) => {
        const before = document.createRange()
        before.setStart(
          field,
          0,
        )
        before.setEnd(
          node,
          offset,
        )
        const copy = before.cloneContents()
        copy.querySelectorAll('[contenteditable=false]').forEach(chip => chip.replaceWith('#'))

        return copy.textContent
      }

      const all = shown({
        node: field,
        offset: field.childNodes.length,
      })
      const anchor = shown({
        node: selection.anchorNode!,
        offset: selection.anchorOffset,
      }).length
      const focus = shown({
        node: selection.focusNode!,
        offset: selection.focusOffset,
      }).length

      return anchor === focus
        ? `${all.slice(
          0,
          focus,
        )}|${all.slice(focus)}`
        : `${all.slice(
          0,
          anchor,
        )}[${all.slice(
          anchor,
          focus,
        )}]${all.slice(focus)}`
    })
    const steps: [string, string][] = []

    const press = async ({ key }: { key: string }) => {
      await composer.press(key)
      steps.push([
        key,
        await caret(),
      ])
    }

    await composer.fill('ab [image: /tmp/shot.png] cd')
    await composer.press('Home')
    await composer.press('ArrowRight')
    await composer.press('ArrowRight')

    for (const key of [
      'ArrowRight',
      'ArrowRight',
      'ArrowLeft',
      'ArrowLeft',
      'ArrowRight',
      'Shift+ArrowRight',
      'Shift+ArrowLeft',
      'ArrowRight',
      'Backspace',
    ]) {
      await press({ key })
    }

    await composer.fill('ab [image: /tmp/shot.png] cd')
    await composer.press('Home')

    for (const key of [
      'ArrowRight',
      'ArrowRight',
      'ArrowRight',
      'Delete',
    ]) {
      await press({ key })
    }

    expect(steps).toEqual([
      [
        'ArrowRight',
        'ab |# cd',
      ],
      [
        'ArrowRight',
        'ab #| cd',
      ],
      [
        'ArrowLeft',
        'ab |# cd',
      ],
      [
        'ArrowLeft',
        'ab| # cd',
      ],
      [
        'ArrowRight',
        'ab |# cd',
      ],
      [
        'Shift+ArrowRight',
        'ab [#] cd',
      ],
      [
        'Shift+ArrowLeft',
        'ab |# cd',
      ],
      [
        'ArrowRight',
        'ab #| cd',
      ],
      [
        'Backspace',
        'ab |cd',
      ],
      [
        'ArrowRight',
        'a|b # cd',
      ],
      [
        'ArrowRight',
        'ab| # cd',
      ],
      [
        'ArrowRight',
        'ab |# cd',
      ],
      [
        'Delete',
        'ab |cd',
      ],
    ])
  },
)
