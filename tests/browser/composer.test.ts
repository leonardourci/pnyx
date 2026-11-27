import { beforeAll, expect, test } from 'vitest'
import type { Page } from 'playwright-core'
import { startOthrys, until, type Othrys } from '../setup/othrys.ts'
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

const mentionsOf = ({ page }: { page: Page }) => page.getByRole(
  'listbox',
  {
    name: 'Mention',
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
      const texts = document.createTreeWalker(
        field,
        NodeFilter.SHOW_TEXT,
      )
      let text = texts.lastChild() as Text

      while (text.parentElement?.closest('[contenteditable=false]')) {
        text = texts.previousNode() as Text
      }

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
  'arrows step over a chip in one press each way, Shift+arrow selects it whole, Backspace or Delete beside it removes it, and an @ right after a chip starts a mention that the next chip ends',
  async () => {
    const titan = await othrys.titan()
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    const composer = composerOf({ page })

    const textAroundCaret = () => composer.evaluate(field => {
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
        await textAroundCaret(),
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

    await composer.fill('[@Review](othrys-column:review)[@Ideas](othrys-column:ideas) x [@Done](othrys-column:done)')
    await composer.press('Home')

    for (const key of [
      'ArrowRight',
      'ArrowRight',
      'End',
      'ArrowLeft',
      'Backspace',
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
      [
        'ArrowRight',
        '#|# x #',
      ],
      [
        'ArrowRight',
        '##| x #',
      ],
      [
        'End',
        '## x #|',
      ],
      [
        'ArrowLeft',
        '## x |#',
      ],
      [
        'Backspace',
        '## x|#',
      ],
    ])

    const mentions = mentionsOf({ page })
    await composer.press('Home')
    await composer.press('ArrowRight')
    await page.keyboard.type('@')
    await mentions.waitFor()
    await composer.press('ArrowRight')
    await mentions.waitFor({ state: 'detached' })
  },
)

test(
  'what the composer sends keeps every chip as its Markdown through copy, paste, cut, Undo and new lines; Undo reselects a cut, closes the @ picker and takes back a whole uploaded image',
  async () => {
    const titan = await othrys.titan()
    othrys.claude.plan({
      titan: titan.id,
      text: 'Start the chat',
      reply: 'Ready.',
    })
    const session = await titan.chat({ text: 'Start the chat' })
    const page = await openTitan({
      port: othrys.port(),
      titanId: titan.id,
    })
    await page.context().grantPermissions([
      'clipboard-read',
      'clipboard-write',
    ])
    const composer = composerOf({ page })
    const mentions = mentionsOf({ page })

    await composer.click()
    await page.keyboard.type('hello')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('world @')
    await mentions.waitFor()

    for (let step = 0; step < 4; step++) {
      await page.keyboard.press('ControlOrMeta+z')
    }

    await mentions.waitFor({ state: 'detached' })
    expect(await composer.textContent()).toBe('')

    await composer.evaluate(field => {
      const pasted = new DataTransfer()
      pasted.items.add(new File(
        ['image'],
        'shot.png',
        { type: 'image/png' },
      ))
      field.dispatchEvent(new ClipboardEvent(
        'paste',
        {
          clipboardData: pasted,
          bubbles: true,
          cancelable: true,
        },
      ))
    })
    await composer.locator('[data-source^="[image: "]:not([data-source*="/pending-image/"])').waitFor()
    await page.keyboard.press('ControlOrMeta+z')
    expect(await composer.locator('[contenteditable=false]').count()).toBe(0)

    await composer.fill('see [@Review](othrys-column:review) and [image: /tmp/shot.png]')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+c')
    await page.keyboard.press('End')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('ControlOrMeta+z')
    expect(await composer.locator('[contenteditable=false]').count()).toBe(2)
    await page.keyboard.press('Backspace')
    await page.keyboard.type(' then ')
    await page.keyboard.press('ControlOrMeta+v')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('last line')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+x')
    expect(await composer.textContent()).toBe('')
    await page.keyboard.press('ControlOrMeta+z')
    expect(await composer.evaluate(() => getSelection()?.isCollapsed)).toBe(false)
    await page.keyboard.press('Enter')

    const sent = 'see [@Review](othrys-column:review) and then see [@Review](othrys-column:review) and [image: /tmp/shot.png]\nlast line'
    await until({
      what: 'the message with its chips as Markdown',
      check: () => session.received.some(heard => heard.includes(sent)),
    })
  },
)
