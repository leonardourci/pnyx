import type { Readiness } from '#agent-host/protocol.ts'

export type NativeStatus = {
  state: Readiness['state'] | 'unavailable'
  build: string
  instance: string
  reasons: string[]
}

export function nativeStatus({
  readiness,
  build,
  instance,
}: {
  readiness: Readiness
  build: string
  instance: string
}): NativeStatus {
  return {
    ...readiness,
    build,
    instance,
  }
}
