// Events within this long fold into one catch-up, so a busy Hydra starts one every few seconds.
export const INDEX_DELAY_MS = 5000

// One catch-up at a time; changes during one fold into a single follow-up. start never rejects.
export function indexRuns({ start }: { start(): Promise<void> }) {
  let running: Promise<void> | null = null
  let again = false
  let waiting: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const run = (): Promise<void> => {
    clearTimeout(waiting)
    waiting = undefined

    if (running) {
      again = true

      return running
    }

    running = start().finally(() => {
      running = null

      if (again && !stopped) {
        again = false
        // Nothing is lost by not awaiting it: start never rejects.
        run()
      }
    })

    return running
  }

  return {
    changed() {
      if (stopped || waiting) {
        return
      }

      waiting = setTimeout(
        run,
        INDEX_DELAY_MS,
      )
    },
    // Resolves after a catch-up that started after this call; a running one may predate the change.
    async ready(): Promise<void> {
      if (!running) {
        return run()
      }

      const current = running
      again = true
      await current
      // The end of current started the follow-up asked for above.
      await running
    },
    stop() {
      stopped = true
      clearTimeout(waiting)
    },
  }
}
