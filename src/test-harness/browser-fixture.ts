/* eslint-disable pnyx/object-params -- Matches the chrome-devtools-axi page API used by these journeys. */
import assert from 'node:assert/strict'
import { browserGroup } from './browser.ts'

type Page = Awaited<ReturnType<ReturnType<typeof browserGroup>['open']>>

export function browserFixture() {
  const group = browserGroup()
  let tab: Page | undefined
  let currentUrl: string | undefined

  const page = () => {
    assert.ok(
      tab,
      'open a page before driving the browser',
    )

    return tab
  }

  const evaluate = async (fn: () => unknown) => page().evaluate({ expression: `(${fn})()` })
  const until = async (fn: () => unknown) => page().shows({
    what: String(fn),
    arg: { source: String(fn) },
    check: ({ source }) => (0, eval)(`(${source})()`) as boolean,
  })
  const driver = {
    eval: evaluate,
    until,
    open: async (url: string) => {
      if (tab && currentUrl === url) {
        await tab.reload()
      } else {
        await tab?.close()
        tab = await group.open({ url })
        currentUrl = url
      }

      await tab.shows({
        what: 'the loaded document',
        check: () => document.readyState === 'complete',
      })
    },
    wait: (selector: string) => page().shows({
      what: selector,
      arg: { selector },
      check: ({ selector }) => document.querySelector(selector),
    }),
    click: async (selector: string) => {
      await page().shows({
        what: `${selector} enabled`,
        arg: { selector },
        check: ({ selector }) => {
          const element = document.querySelector(selector)

          return element && !element.matches(':disabled')
        },
      })

      return page().click({ selector })
    },
    type: (text: string) => page().type({ text }),
    press: async (key: string) => {
      if ([
        'Enter',
        'Space',
        'ArrowDown',
        'ArrowUp',
        'Tab',
        'Escape',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'F2',
      ].includes(key)) {
        await page().press({ key: key as Parameters<Page['press']>[0]['key'] })
      } else {
        assert.equal(
          key.length,
          1,
          `unsupported key: ${key}`,
        )
        await page().type({ text: key })
      }
    },
    fill: async (
      selector: string,
      text: string,
    ) => {
      await driver.wait(selector)
      await page().evaluate({
        expression: `(async () => {
        const input = document.querySelector(${JSON.stringify(selector)})
        input.focus()
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
        input.setSelectionRange(input.value.length, input.value.length)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise(resolve => queueMicrotask(resolve))
      })()`,
      })
    },
  }

  const run = async ({
    args,
    script,
  }: {
    args: string[]
    script?: string
  }) => {
    switch (args[0]) {
      case 'open': await driver.open(args[1]!)

        return ''
      case 'stop': await tab?.close(); tab = undefined

        return ''
      case 'resize': await page().resize({
        width: Number(args[1]),
        height: Number(args[2]),
      })

        return ''
      case 'screenshot': await page().capture({ path: args[1]! })

        return ''
      case 'eval': return JSON.stringify(await page().evaluate({ expression: `(${args[1]})()` }))
      case 'run': {
        const output: string[] = []
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
        const execute = AsyncFunction as new (...args: string[]) =>
        (
          page: typeof driver,
          console: { log: (value: unknown) => void },
        ) => Promise<void>

        try {
          await new execute(
            'page',
            'console',
            script!,
          )(
            driver,
            {
              log: value => {
                output.push(String(value))
              },
            },
          )
        } catch (error) {
          const state = await page().evaluate({
            expression: `JSON.stringify({
            title: document.title,
            meta: document.querySelector('meta[name=pnyx-hydra]')?.content,
            menu: document.querySelector('.slash-menu')?.outerHTML,
            entries: [...document.querySelectorAll('[data-entry-id]')].map(row => row.getAttribute('data-entry-id')),
            decisions: document.querySelector('.waiting-decisions')?.outerHTML,
            text: document.body.innerText.slice(-6000)
          })`,
          })

          throw new Error(
            `${String(error)}\nPage state: ${state}`,
            { cause: error },
          )
        }

        return output.join('\n')
      }
      default: throw new Error(`unsupported browser operation: ${args[0]}`)
    }
  }

  return run
}
