/* eslint-disable pnyx/object-params -- These fakes implement browser-owned callback and constructor signatures. */
import { afterEach, expect, test, vi } from 'vitest'
import { recordUIRender, setUIMetricsEnabled, startUIMetrics, timeUIFlow, trackUIDrag, UI_METRICS_INTERVAL_MS } from '../web/src/app/ui-metrics.ts'
import type { PageLine } from '#app/log-line.ts'

class Observer {
  static supportedEntryTypes = [
    'longtask',
    'event',
    'long-animation-frame',
  ]

  static callbacks = new Map<string, PerformanceObserverCallback>()
  type = ''
  readonly callback: PerformanceObserverCallback
  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback
  }

  observe({ type }: { type: string }) {
    this.type = type
    Observer.callbacks.set(
      type,
      this.callback,
    )
  }

  disconnect() {
    Observer.callbacks.delete(this.type)
  }

  static deliver({
    type,
    entries,
  }: {
    type: string
    entries: object[]
  }) {
    Observer.callbacks.get(type)?.(
      { getEntries: () => entries } as PerformanceObserverEntryList,
      {} as PerformanceObserver,
    )
  }
}

class Control {
  tagName = 'BUTTON'
  closest(selector: string) {
    return selector.includes('button') || selector.includes('data-ui-') ? this : null
  }

  getAttribute(name: string) {
    if (name === 'data-ui-surface') {
      return 'settings'
    }

    if (name === 'data-ui-action') {
      return 'settings.open'
    }

    return null
  }
}

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Observer.callbacks.clear()
})

function start() {
  vi.useFakeTimers({
    toFake: [
      'setInterval',
      'clearInterval',
      'performance',
    ],
  })
  vi.stubGlobal(
    'PerformanceObserver',
    Observer,
  )
  vi.stubGlobal(
    'Element',
    Control,
  )
  vi.stubGlobal(
    'addEventListener',
    vi.fn(),
  )
  vi.stubGlobal(
    'removeEventListener',
    vi.fn(),
  )
  setUIMetricsEnabled({ enabled: true })
  const lines: PageLine[] = []
  cleanup = startUIMetrics({ log: line => lines.push(line) })

  return lines
}

test(
  'browser measurements aggregate, deduplicate interaction IDs and sample React commits without control text',
  () => {
    const lines = start()
    Observer.deliver({
      type: 'longtask',
      entries: [
        { duration: 80 },
        { duration: 120 },
      ],
    })
    Observer.deliver({
      type: 'long-animation-frame',
      entries: [
        {
          duration: 90,
          blockingDuration: 40,
          scripts: [
            {
              duration: 70,
              invoker: 'timer',
            },
          ],
        },
      ],
    })
    Observer.deliver({
      type: 'event',
      entries: [
        {
          interactionId: 7,
          duration: 160,
          startTime: 0,
          processingStart: 20,
          processingEnd: 100,
          target: new Control(),
        },
        {
          interactionId: 7,
          duration: 200,
          startTime: 0,
          processingStart: 30,
          processingEnd: 150,
          target: new Control(),
        },
        {
          interactionId: 0,
          duration: 500,
          target: new Control(),
        },
      ],
    })
    Array.from(
      { length: 11 },
      () => recordUIRender({
        surface: 'chat',
        hydraId: 'sample',
        ms: 8,
      }),
    )
    const finish = timeUIFlow({
      surface: 'settings',
      action: 'settings.open',
    })
    vi.advanceTimersByTime(25)
    finish(); finish()
    expect(lines).toEqual([])
    vi.advanceTimersByTime(UI_METRICS_INTERVAL_MS)
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'page.long-task',
        count: 2,
        totalMs: 200,
        ms: 120,
      }),
      expect.objectContaining({
        operation: 'page.slow-frame',
        ms: 90,
        blockingMs: 40,
        script: 'timer',
      }),
      expect.objectContaining({
        operation: 'page.slow-interaction',
        surface: 'settings',
        action: 'settings.open',
        count: 1,
        ms: 200,
        inputDelayMs: 30,
        processingMs: 120,
        presentationMs: 50,
      }),
      expect.objectContaining({
        operation: 'page.react-commit',
        hydraId: 'sample',
        surface: 'chat',
        count: 11,
        samples: 2,
        totalMs: 16,
        ms: 8,
      }),
      expect.objectContaining({
        operation: 'page.flow',
        count: 1,
        ms: 25,
      }),
      expect.objectContaining({
        operation: 'page.metrics-overhead',
        ms: expect.any(Number),
      }),
    ]))
  },
)

test(
  'drag sampling survives logger cleanup, while Logs Off cancels frames and pending measurements',
  () => {
    const lines = start()
    let tick: FrameRequestCallback | undefined
    vi.stubGlobal(
      'document',
      {
        visibilityState: 'visible',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    )
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) => {
        tick = callback

        return 1
      },
    )
    const cancel = vi.fn()
    vi.stubGlobal(
      'cancelAnimationFrame',
      cancel,
    )
    trackUIDrag({ action: 'task' })
    tick?.(10); tick?.(26); tick?.(74)
    const finish = timeUIFlow({
      surface: 'workspace',
      action: 'task.open',
    })
    setUIMetricsEnabled({ enabled: false })
    expect(Observer.callbacks.size).toBe(0)
    expect(cancel).toHaveBeenCalledWith(1)
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    )
    vi.advanceTimersByTime(UI_METRICS_INTERVAL_MS)
    expect(lines).toEqual([])
    setUIMetricsEnabled({ enabled: true })
    finish()
    const end = trackUIDrag({ action: 'project' })
    tick?.(100); tick?.(116); tick?.(164)
    end(); end()
    vi.advanceTimersByTime(UI_METRICS_INTERVAL_MS)
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'page.drag-frames',
        action: 'project',
        count: 1,
        frameCount: 2,
        frames: 2,
        worstFrameMs: 48,
      }),
    ]))
    expect(lines.some(line => line.operation === 'page.flow')).toBe(false)
    const beforeCleanup = lines.length
    trackUIDrag({ action: 'task' })
    tick?.(200); tick?.(216); tick?.(264)
    cleanup?.()
    cleanup = undefined
    expect(lines.slice(beforeCleanup)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'page.drag-frames',
        action: 'task',
        frameCount: 2,
        frames: 2,
      }),
    ]))
  },
)

test(
  'untrusted action names and excessive metric groups stay bounded',
  () => {
    const lines = start()
    timeUIFlow({
      surface: 'chat',
      action: 'private owner text',
    })()
    Array.from(
      { length: 40 },
      (
        _,
        index,
      ) => timeUIFlow({
        surface: 'chat',
        action: `flow.${index}`,
      })(),
    )
    vi.advanceTimersByTime(UI_METRICS_INTERVAL_MS)
    expect(lines.filter(line => line.operation === 'page.flow')).toHaveLength(32)
    expect(lines.find(line => line.operation === 'page.metrics-overhead')).toMatchObject({ samples: 8 })
    expect(JSON.stringify(lines)).not.toContain('private owner text')
  },
)

test(
  'observer input is bounded before aggregation',
  () => {
    const lines = start()
    Observer.deliver({
      type: 'longtask',
      entries: Array.from(
        { length: 200 },
        () => ({ duration: 80 }),
      ),
    })
    vi.advanceTimersByTime(UI_METRICS_INTERVAL_MS)
    expect(lines.find(line => line.operation === 'page.long-task')).toMatchObject({
      count: 128,
      totalMs: 10240,
    })
    expect(lines.find(line => line.operation === 'page.metrics-overhead')).toMatchObject({ samples: 72 })
  },
)
