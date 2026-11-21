// Waits end as soon as their condition holds; the bound only has to outlast a loaded machine.
export const WAIT_MS = 20_000
const POLL_MS = 20

export async function until<T>({
  what,
  check,
  timeoutMs = WAIT_MS,
}: {
  what: string
  check: () => T | undefined | false | Promise<T | undefined | false>
  timeoutMs?: number
}): Promise<T> {
  const end = performance.now() + timeoutMs
  let value = await check()

  while (value === undefined || value === false) {
    if (performance.now() > end) {
      throw new Error(`timed out waiting for ${what} (last: ${String(value)})`)
    }

    await new Promise(resolve => setTimeout(
      resolve,
      POLL_MS,
    ))
    value = await check()
  }

  return value
}
