import type { Maintenance } from '#agent-host/protocol.ts'

export type NativeStatus = {
  state: 'ready' | 'draining' | 'unavailable' | 'recovery_required'
  build: string
  instance: string
  reasons: string[]
}

export function nativeStatus({
  maintenance,
  build,
  instance,
}: {
  maintenance: Maintenance
  build: string
  instance: string
}): NativeStatus {
  const reasons = [...new Set(maintenance.blockers.flatMap(blocker => blocker.reasons))]
  const uncertain = reasons.some(reason => /ownership|recovery|retention/i.test(reason))

  return {
    build,
    instance,
    state: uncertain ? 'recovery_required' : maintenance.mode === 'ready' ? 'ready' : 'draining',
    reasons,
  }
}
