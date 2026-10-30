export function serial() {
  let tail = Promise.resolve()

  return {
    run<T>({ action }: { action(): Promise<T> }): Promise<T> {
      const before = tail
      const result = (async () => {
        await before

        return action()
      })()
      tail = (async () => {
        try {
          await result
        } catch {
          // Each caller receives its own failure; a rejected mutation cannot wedge later barriers.
        }
      })()

      return result
    },
  }
}
