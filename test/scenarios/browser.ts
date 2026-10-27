// One headless Chrome for a scenario file, driven over the DevTools protocol on a pipe: no port,
// no extra process and a temporary profile of its own. See test/README.md.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { after, before } from 'node:test'
import { POLL_MS, TIMEOUT_MS } from './harness.ts'

function chromePath(): string {
  const found = [
    process.env.PNYX_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(path => path && existsSync(path))
  assert.ok(
    found,
    'browser scenarios need Chrome: install it or set PNYX_CHROME to its binary',
  )

  return found
}

type Message = Record<string, unknown>

interface ExceptionDetails {
  exception?: { description?: string }
  text: string
}

const describe = ({ details }: { details: ExceptionDetails }) =>
  details.exception?.description ?? details.text

// The keys the journeys press; a key with text also types it, as Enter does in a field.
const KEYS: Record<'Enter' | 'Space' | 'ArrowDown' | 'ArrowUp' | 'Tab' | 'Escape' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'F2', {
  keyCode: number
  key?: string
  text?: string
}> = {
  Enter: {
    keyCode: 13,
    text: '\r',
  },
  Space: {
    keyCode: 32,
    key: ' ',
    text: ' ',
  },
  ArrowDown: { keyCode: 40 },
  ArrowUp: { keyCode: 38 },
  ArrowLeft: { keyCode: 37 },
  ArrowRight: { keyCode: 39 },
  Tab: { keyCode: 9 },
  Home: { keyCode: 36 },
  F2: { keyCode: 113 },
  Escape: { keyCode: 27 },
}

// Starts Chrome before the file's tests and stops it after; call it at the top level of the file.
export function browserGroup() {
  const profile = mkdtempSync(join(
    tmpdir(),
    'pnyx-chrome-',
  ))
  const chrome = {
    process: undefined as ReturnType<typeof spawn> | undefined,
    input: undefined as Writable | undefined,
    exited: false,
  }
  let next = 0
  const waiting = new Map<number, ({
    result,
    error,
  }: {
    result?: Message
    error?: Error
  }) => void>()
  // Uncaught errors each open tab's page threw, by its session.
  const pageErrors = new Map<string, string[]>()
  const consoleErrors = new Map<string, string[]>()

  const send = ({
    method,
    params = {},
    sessionId,
  }: {
    method: string
    params?: Message
    sessionId?: string
  }) => new Promise<Message>((
    resolve,
    reject,
  ) => {
    if (chrome.exited) {
      reject(new Error(`Chrome exited before ${method}`))

      return
    }

    const id = ++next
    const timer = setTimeout(
      () => {
        waiting.delete(id)
        reject(new Error(`Chrome did not answer ${method}`))
      },
      // Longer than a wait in the page, so that wait reports what it waited for.
      2 * TIMEOUT_MS,
    )
    waiting.set(
      id,
      ({
        result,
        error,
      }) => {
        clearTimeout(timer)

        if (error) {
          reject(error)
        } else {
          resolve(result!)
        }
      },
    )
    chrome.input!.write(`${JSON.stringify({
      id,
      method,
      params,
      sessionId,
    })}\0`)
  })

  before(async () => {
    const child = spawn(
      chromePath(),
      [
        '--headless=new',
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
        // Without it macOS Chrome waits on the login keychain before its first request.
        '--use-mock-keychain',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        // A tab left behind another must keep its timers, frames and smooth scrolls running.
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--window-size=1280,900',
        'about:blank',
      ],
      {
        stdio: [
          'ignore',
          'ignore',
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    )
    chrome.process = child
    // Chrome reads commands on fd 3 and answers on fd 4.
    chrome.input = child.stdio[3] as Writable
    const output = child.stdio[4] as Readable

    const fail = ({ error }: { error: Error }) => {
      chrome.exited = true

      for (const settle of waiting.values()) {
        settle({ error })
      }

      waiting.clear()
    }

    child.once(
      'error',
      error => fail({ error }),
    )
    child.once(
      'exit',
      () => fail({ error: new Error('Chrome exited') }),
    )
    chrome.input.on(
      'error',
      error => fail({ error }),
    )
    output.setEncoding('utf8')
    let buffer = ''
    output.on(
      'data',
      (data: string) => {
        const frames = (buffer + data).split('\0')
        buffer = frames.pop()!

        for (const frame of frames) {
          const message = JSON.parse(frame) as Message
          const id = message.id as number | undefined
          const settle = id === undefined ? undefined : waiting.get(id)

          if (settle) {
            waiting.delete(id!)
            settle(message.error
              ? { error: new Error(JSON.stringify(message.error)) }
              : { result: message.result as Message })
          } else if (message.method === 'Runtime.consoleAPICalled') {
            const params = message.params as {
              type: string
              args: {
                value?: unknown
                description?: string
              }[]
            }

            if (params.type === 'error') {
              consoleErrors.get(message.sessionId as string)?.push(params.args.map(arg =>
                String(arg.value ?? arg.description)).join(' '))
            }
          } else if (message.method === 'Runtime.exceptionThrown') {
            const { exceptionDetails } = message.params as { exceptionDetails: ExceptionDetails }
            const errors = pageErrors.get(message.sessionId as string)
            errors?.push(describe({ details: exceptionDetails }))
          }
        }
      },
    )
    await send({ method: 'Browser.getVersion' })
  })
  after(async () => {
    if (chrome.process && !chrome.exited) {
      const exited = once(
        chrome.process,
        'exit',
      )
      chrome.process.kill()
      await exited
    }

    rmSync(
      profile,
      {
        recursive: true,
        force: true,
      },
    )
  })

  return {
    // A new tab on this URL. An uncaught error on the page fails its close().
    open: async ({ url }: { url: string }) => {
      const { targetId } = await send({
        method: 'Target.createTarget',
        params: { url: 'about:blank' },
      }) as { targetId: string }
      const { sessionId } = await send({
        method: 'Target.attachToTarget',
        params: {
          targetId,
          flatten: true,
        },
      }) as { sessionId: string }
      pageErrors.set(
        sessionId,
        [],
      )
      consoleErrors.set(
        sessionId,
        [],
      )
      const call = ({
        method,
        params,
      }: {
        method: string
        params?: Message
      }) => send({
        method,
        params,
        sessionId,
      })
      await call({ method: 'Runtime.enable' })
      await call({
        method: 'Page.navigate',
        params: { url },
      })

      // Waits in the page until check(arg) returns something truthy, and returns it (an element as true).
      // The check is sent as its source, so it can use only its argument and the page's globals.
      const shows = async <T, A = undefined>({
        what,
        check,
        arg,
      }: {
        what: string
        check: ({ ...arg }: A) => T | undefined | null | false
        arg?: A
      }): Promise<T> => {
        const {
          result,
          exceptionDetails,
        } = await call({
          method: 'Runtime.evaluate',
          params: {
            expression: `new Promise((resolve, reject) => {
              const check = ${String(check)}
              const end = Date.now() + ${TIMEOUT_MS}
              const tick = () => {
                let value
                try {
                  value = check(${JSON.stringify(arg ?? null)})
                } catch (error) {
                  reject(error)
                  return
                }
                if (value) {
                  resolve(value instanceof Node ? true : value)
                } else if (Date.now() > end) {
                  reject(new Error(${JSON.stringify(`timed out waiting for ${what}`)}))
                } else {
                  setTimeout(tick, ${POLL_MS})
                }
              }
              tick()
            })`,
            awaitPromise: true,
            returnByValue: true,
          },
        }) as {
          result: { value: T }
          exceptionDetails?: ExceptionDetails
        }

        if (exceptionDetails) {
          throw new Error(describe({ details: exceptionDetails }))
        }

        return result.value
      }

      return {
        shows,
        errors: () => ({
          exceptions: pageErrors.get(sessionId) ?? [],
          console: consoleErrors.get(sessionId) ?? [],
        }),
        evaluate: async ({ expression }: { expression: string }): Promise<unknown> => {
          const {
            result,
            exceptionDetails,
          } = await call({
            method: 'Runtime.evaluate',
            params: {
              expression,
              awaitPromise: true,
              returnByValue: true,
            },
          }) as {
            result: { value?: unknown }
            exceptionDetails?: ExceptionDetails
          }

          if (exceptionDetails) {
            throw new Error(describe({ details: exceptionDetails }))
          }

          return result.value
        },
        resize: ({
          width,
          height,
        }: {
          width: number
          height: number
        }) => call({
          method: 'Emulation.setDeviceMetricsOverride',
          params: {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          },
        }),
        reload: async () => {
          const before = await call({
            method: 'Runtime.evaluate',
            params: {
              expression: 'performance.timeOrigin',
              returnByValue: true,
            },
          }) as { result: { value: number } }
          await call({ method: 'Page.reload' })
          const end = Date.now() + TIMEOUT_MS

          while (Date.now() < end) {
            try {
              const current = await call({
                method: 'Runtime.evaluate',
                params: {
                  expression: '({origin: performance.timeOrigin, ready: document.readyState})',
                  returnByValue: true,
                },
              }) as {
                result: {
                  value?: {
                    origin: number
                    ready: string
                  }
                }
              }

              if (current.result.value?.origin !== before.result.value && current.result.value?.ready === 'complete') {
                return
              }
            } catch (error) {
              if (!/navigated|context.*destroyed|Cannot find context/i.test(String(error))) {
                throw error
              }
            }

            await new Promise(resolve => setTimeout(
              resolve,
              POLL_MS,
            ))
          }

          throw new Error('timed out waiting for the reloaded document')
        },
        capture: async ({ path }: { path: string }) => {
          const { data } = await call({
            method: 'Page.captureScreenshot',
            params: { format: 'png' },
          }) as { data: string }
          writeFileSync(
            path,
            Buffer.from(
              data,
              'base64',
            ),
          )
        },
        // A real mouse click on the first visible match (with this text, when given), so mousedown
        // handlers run too; it waits until nothing covers the element's centre.
        click: async ({
          selector,
          text,
        }: {
          selector: string
          text?: string
        }) => {
          const target = text ? `${selector} with "${text}"` : selector
          const {
            x,
            y,
          } = await shows({
            what: `${target} to click`,
            arg: {
              selector,
              text,
            },
            check: ({
              selector,
              text,
            }) => {
              const candidate = [...document.querySelectorAll(selector)]
                .filter(element => element.getClientRects().length > 0)
                .find(element => !text || element.textContent?.includes(text))

              if (!candidate) {
                return undefined
              }

              candidate.scrollIntoView({ block: 'nearest' })
              const box = candidate.getBoundingClientRect()
              const centre = {
                x: box.left + box.width / 2,
                y: box.top + box.height / 2,
              }

              return candidate.contains(document.elementFromPoint(
                centre.x,
                centre.y,
              )) && centre
            },
          })

          for (const type of [
            'mouseMoved',
            'mousePressed',
            'mouseReleased',
          ]) {
            await call({
              method: 'Input.dispatchMouseEvent',
              params: {
                type,
                x,
                y,
                button: 'left',
                clickCount: 1,
              },
            })
          }
        },
        // Text typed at the focused element, as one input.
        type: ({ text }: { text: string }) => call({
          method: 'Input.insertText',
          params: { text },
        }),
        press: async ({ key }: { key: keyof typeof KEYS }) => {
          const {
            keyCode,
            key: value = key,
            text,
          } = KEYS[key]
          await call({
            method: 'Input.dispatchKeyEvent',
            params: {
              type: text ? 'keyDown' : 'rawKeyDown',
              key: value,
              code: key,
              windowsVirtualKeyCode: keyCode,
              text,
            },
          })
          await call({
            method: 'Input.dispatchKeyEvent',
            params: {
              type: 'keyUp',
              key: value,
              code: key,
              windowsVirtualKeyCode: keyCode,
            },
          })
        },
        upload: async ({
          selector,
          files,
        }: {
          selector: string
          files: string[]
        }) => {
          const { result } = await call({
            method: 'Runtime.evaluate',
            params: { expression: `document.querySelector(${JSON.stringify(selector)})` },
          }) as { result: { objectId?: string } }
          assert.ok(
            result.objectId,
            `no ${selector} to upload into`,
          )
          await call({
            method: 'DOM.setFileInputFiles',
            params: {
              objectId: result.objectId,
              files,
            },
          })
        },
        close: async () => {
          await send({
            method: 'Target.closeTarget',
            params: { targetId },
          })
          const errors = pageErrors.get(sessionId)
          pageErrors.delete(sessionId)
          consoleErrors.delete(sessionId)
          assert.deepEqual(
            errors,
            [],
            'the page threw',
          )
        },
      }
    },
  }
}
