import { useEffect } from 'react'

export function useScrollingClass() {
  useEffect(
    () => {
      const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

      const scroll = (event: Event) => {
        const target = event.target

        if (!(target instanceof HTMLElement)) {
          return
        }

        clearTimeout(timers.get(target)); target.classList.add('scrolling')
        timers.set(
          target,
          setTimeout(
            () => {
              target.classList.remove('scrolling'); timers.delete(target)
            },
            700,
          ),
        )
      }

      document.addEventListener(
        'scroll',
        scroll,
        true,
      )

      return () => {
        document.removeEventListener(
          'scroll',
          scroll,
          true,
        ); timers.forEach(timer => clearTimeout(timer))
      }
    },
    [],
  )
}
