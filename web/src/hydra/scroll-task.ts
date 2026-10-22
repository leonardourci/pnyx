export function afterDelay({
  ms,
  signal,
}: {
  ms: number
  signal: AbortSignal
}): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }

  return new Promise(resolve => {
    const abort = () => {
      clearTimeout(timer)
      resolve(false)
    }

    const timer = setTimeout(
      () => {
        signal.removeEventListener(
          'abort',
          abort,
        )
        resolve(!signal.aborted)
      },
      ms,
    )
    signal.addEventListener(
      'abort',
      abort,
      { once: true },
    )
  })
}

export function afterTaskLayout({ signal }: { signal: AbortSignal }): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }

  return new Promise(resolve => {
    let frame = 0

    const finish = ({ ready }: { ready: boolean }) => {
      cancelAnimationFrame(frame)
      signal.removeEventListener(
        'abort',
        abort,
      )
      resolve(ready)
    }

    const abort = () => finish({ ready: false })
    signal.addEventListener(
      'abort',
      abort,
      { once: true },
    )
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => finish({ ready: !signal.aborted }))
    })
  })
}

function scrollAxis({
  element,
  left,
  top,
  signal,
  reduced,
}: {
  element: HTMLElement
  left: number
  top: number
  signal: AbortSignal
  reduced: boolean
}): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }

  if (Math.abs(element.scrollLeft - left) < 1 && Math.abs(element.scrollTop - top) < 1) {
    element.scrollTo({
      left,
      top,
      behavior: 'instant',
    })

    return Promise.resolve(true)
  }

  if (reduced) {
    element.scrollTo({
      left,
      top,
      behavior: 'instant',
    })

    return Promise.resolve(true)
  }

  return new Promise(resolve => {
    const finish = ({ ready }: { ready: boolean }) => {
      element.removeEventListener(
        'scrollend',
        ended,
      )
      signal.removeEventListener(
        'abort',
        abort,
      )
      resolve(ready)
    }

    const ended = (event: Event) => {
      if (event.target === element) {
        finish({ ready: !signal.aborted })
      }
    }

    const abort = () => {
      element.scrollTo({
        left: element.scrollLeft,
        top: element.scrollTop,
        behavior: 'instant',
      })
      finish({ ready: false })
    }

    element.addEventListener(
      'scrollend',
      ended,
    )
    signal.addEventListener(
      'abort',
      abort,
      { once: true },
    )
    element.scrollTo({
      left,
      top,
      behavior: 'smooth',
    })
  })
}

export async function scrollTask({
  element,
  signal,
}: {
  element: HTMLElement
  signal: AbortSignal
}): Promise<boolean> {
  const kanban = element.closest<HTMLElement>('.kanban')
  const column = element.closest<HTMLElement>('[data-column]')
  const cards = element.closest<HTMLElement>('.column-cards')

  if (!kanban || !column || !cards || !element.isConnected || signal.aborted) {
    return false
  }

  const viewport = kanban.getBoundingClientRect()
  const bounds = column.getBoundingClientRect()
  const left = viewport.left + kanban.clientLeft
  const right = left + kanban.clientWidth
  const shift = bounds.width > kanban.clientWidth || bounds.left < left
    ? bounds.left - left : bounds.right > right ? bounds.right - right : 0
  const x = Math.round(Math.max(
    0,
    Math.min(
      kanban.scrollWidth - kanban.clientWidth,
      kanban.scrollLeft + shift,
    ),
  ))
  const y = Math.round(Math.max(
    0,
    Math.min(
      cards.scrollHeight - cards.clientHeight,
      cards.scrollTop + element.getBoundingClientRect().top - cards.getBoundingClientRect().top
      - cards.clientTop - parseFloat(getComputedStyle(cards).paddingTop),
    ),
  ))
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const results = await Promise.all([
    scrollAxis({
      element: kanban,
      left: x,
      top: kanban.scrollTop,
      signal,
      reduced,
    }),
    scrollAxis({
      element: cards,
      left: cards.scrollLeft,
      top: y,
      signal,
      reduced,
    }),
  ])

  return results.every(Boolean) && element.isConnected && !signal.aborted
}

// Focus, alignment and closing the replaced card wait for hold, so a rename keeps its target.
export async function openTaskCard({
  find,
  expand,
  settle,
  hold,
  release,
  opened,
  align,
  signal,
}: {
  find(): HTMLElement | null
  expand(): void
  settle(): Promise<boolean>
  hold({ element }: { element: HTMLElement }): Promise<boolean>
  release(): void
  opened({ element }: { element: HTMLElement }): void
  align({ element }: { element: HTMLElement }): Promise<boolean>
  signal: AbortSignal
}): Promise<HTMLElement | null> {
  if (!find() && !await settle()) {
    return null
  }

  if (!find() || signal.aborted) {
    return null
  }

  expand()

  try {
    const held = await settle() && find()

    if (!held) {
      return null
    }

    const kept = await hold({ element: held })
    release()

    if (!kept || !await settle()) {
      return null
    }

    const element = find()

    if (!element) {
      return null
    }

    opened({ element })

    return await align({ element }) && element.isConnected && !signal.aborted ? element : null
  } finally {
    release()
  }
}
