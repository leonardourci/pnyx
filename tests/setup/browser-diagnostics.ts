import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'

export async function recordBrowserDiagnostics({
  page,
  name,
}: {
  page: Page
  name: string
}) {
  const kept = process.env.PNYX_KEEP_TEST_FILES

  if (!kept) {
    return
  }

  const folder = join(
    kept,
    'browser-diagnostics',
    name,
  )
  mkdirSync(
    folder,
    { recursive: true },
  )
  const context = page.context()
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  })
  const entries: unknown[] = []

  page.on(
    'console',
    message => {
      const text = message.text()

      if (text.startsWith('PNYX_FIRST_ESCAPE ')) {
        entries.push({
          event: 'firstEscape',
          state: JSON.parse(text.slice('PNYX_FIRST_ESCAPE '.length)),
        })
      }

      if (text.startsWith('PNYX_DRAG_DIAGNOSTIC ')) {
        entries.push(JSON.parse(text.slice('PNYX_DRAG_DIAGNOSTIC '.length)))
      }
    },
  )
  await page.addInitScript(() => {
    const pointer = {
      x: 0,
      y: 0,
      buttons: 0,
      shift: false,
    }
    let recording = false

    const append = ({
      event,
      state,
    }: {
      event: string
      state: unknown
    }) => {
      console.debug('PNYX_DRAG_DIAGNOSTIC ' + JSON.stringify({
        at: performance.now(),
        origin: performance.timeOrigin,
        event,
        state,
      }))
    }

    const describe = ({ node }: { node: Element | null }) => node ? {
      tag: node.tagName,
      class: node.className,
      hydra: node.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace,
    } : null
    let lastDialog: HTMLDialogElement | null = null
    const nativeShowModal = HTMLDialogElement.prototype.showModal

    HTMLDialogElement.prototype.showModal = function () {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Keep the opened node available after DOM detachment.
      lastDialog = this
      append({
        event: 'showModalBefore',
        state: {
          node: describe({ node: this }),
          open: this.open,
          modal: this.matches(':modal'),
          stack: new Error().stack,
        },
      })
      nativeShowModal.call(this)
      append({
        event: 'showModalAfter',
        state: {
          open: this.open,
          modal: this.matches(':modal'),
        },
      })
    }

    const nativeClose = HTMLDialogElement.prototype.close

    // eslint-disable-next-line pnyx/object-params -- The native dialog close method owns this signature.
    HTMLDialogElement.prototype.close = function (...args: Parameters<HTMLDialogElement['close']>) {
      append({
        event: 'closeBefore',
        state: {
          open: this.open,
          modal: this.matches(':modal'),
          stack: new Error().stack,
        },
      })
      nativeClose.apply(
        this,
        args,
      )
      append({
        event: 'closeAfter',
        state: {
          open: this.open,
          modal: this.matches(':modal'),
        },
      })
    }

    new MutationObserver(records => {
      if (!lastDialog?.open) {
        return
      }

      for (const record of records) {
        for (const node of [...record.removedNodes]) {
          if (node === lastDialog || node.contains(lastDialog)) {
            append({
              event: 'dialogDetached',
              state: {
                removed: node instanceof Element ? describe({ node }) : null,
                parent: record.target instanceof Element ? describe({ node: record.target }) : null,
                connected: lastDialog.isConnected,
                modal: lastDialog.matches(':modal'),
              },
            })
          }
        }
      }
    }).observe(
      document,
      {
        childList: true,
        subtree: true,
      },
    )
    document.addEventListener(
      'pnyx:drag-diagnostic',
      event => {
        append({
          event: 'app',
          state: (event as CustomEvent).detail,
        })
      },
    )
    document.addEventListener(
      'pointermove',
      event => {
        recording = true
        Object.assign(
          pointer,
          {
            x: event.clientX,
            y: event.clientY,
            buttons: event.buttons,
            shift: event.shiftKey,
          },
        )
        append({
          event: 'pointermove',
          state: { ...pointer },
        })
      },
      true,
    )

    for (const type of [
      'keydown',
      'keyup',
    ]) {
      document.addEventListener(
        type,
        event => {
          const key = event as KeyboardEvent
          pointer.shift = key.shiftKey
          append({
            event: type,
            state: {
              key: key.key,
              ...pointer,
            },
          })
        },
        true,
      )
    }

    // eslint-disable-next-line pnyx/object-params -- PerformanceObserver supplies its entry list.
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        append({
          event: 'longtask',
          state: {
            start: entry.startTime,
            duration: entry.duration,
          },
        })
      }
    }).observe({
      type: 'longtask',
      buffered: true,
    })

    const frame = () => {
      if (recording) {
        const pointed = document.elementFromPoint(
          pointer.x,
          pointer.y,
        )
        append({
          event: 'frame',
          state: {
            pointer: { ...pointer },
            pointed: pointed?.outerHTML.slice(
              0,
              500,
            ),
            pointedTask: pointed?.closest<HTMLElement>('[data-task]')?.dataset.task,
            axis: document.querySelector('.workspace-axis')?.scrollLeft,
            dragging: document.querySelector('[data-dragging]')?.getAttribute('data-dragging'),
            ghost: document.querySelector('.physical-ghost')?.textContent,
            dialogs: [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].map(dialog => {
              const option = dialog.querySelector<HTMLElement>('[data-value="panel:projects"]')
              const box = option?.getBoundingClientRect()
              const style = getComputedStyle(dialog)

              return {
                modal: dialog.matches(':modal'),
                open: dialog.open,
                connected: dialog.isConnected,
                node: describe({ node: dialog }),
                box: dialog.getBoundingClientRect().toJSON(),
                position: style.position,
                zIndex: style.zIndex,
                option: box?.toJSON(),
                hit: box ? describe({
                  node: document.elementFromPoint(
                    box.x + box.width / 2,
                    box.y + box.height / 2,
                  ),
                }) : null,
              }
            }),
            cards: [...document.querySelectorAll<HTMLElement>('.card[data-task]:not(.physical-ghost *)')].map(card => ({
              id: card.dataset.task,
              title: card.querySelector('.card-open')?.textContent,
              box: card.getBoundingClientRect().toJSON(),
              nestArmed: card.dataset.nestArmed,
              parent: card.closest('[data-child]')?.getAttribute('data-child'),
              fold: card.closest('[data-fold-open]')?.getAttribute('data-fold-open'),
              hovered: card.matches(':hover'),
            })),
            handles: [...document.querySelectorAll<HTMLElement>('[aria-label^="Move "]')].map(handle => ({
              label: handle.getAttribute('aria-label'),
              box: handle.getBoundingClientRect().toJSON(),
              popover: handle.closest('[popover]')?.matches(':popover-open'),
            })),
          },
        })
      }

      requestAnimationFrame(frame)
    }

    requestAnimationFrame(frame)
  })
  const close = context.close.bind(context)

  // The journey closes its page in finally, before Vitest reports the failure.
  // eslint-disable-next-line pnyx/object-params -- Playwright owns the close method signature.
  context.close = async options => {
    try {
      await page.screenshot({
        path: join(
          folder,
          'last-frame.png',
        ),
      })
      writeFileSync(
        join(
          folder,
          'frames.json',
        ),
        JSON.stringify(entries),
      )
      await context.tracing.stop({
        path: join(
          folder,
          'trace.zip',
        ),
      })
    } finally {
      await close(options)
    }
  }
}
