import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'

export async function recordDragDiagnostics({
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
    'drag-diagnostics',
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
  await page.addInitScript(() => {
    const entries: unknown[] = JSON.parse(sessionStorage.getItem('dragDiagnosticEntries') ?? '[]')
    window.addEventListener(
      'beforeunload',
      () => {
        sessionStorage.setItem(
          'dragDiagnosticEntries',
          JSON.stringify(entries),
        )
      },
    )
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
      entries.push({
        at: performance.now(),
        origin: performance.timeOrigin,
        event,
        state,
      })
    }

    Object.assign(
      window,
      { dragDiagnosticEntries: entries },
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
        JSON.stringify(await page.evaluate(() =>
          Reflect.get(
            window,
            'dragDiagnosticEntries',
          ))),
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
