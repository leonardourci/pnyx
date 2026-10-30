import type { NativeWork } from './provider.ts'

export function nativeIdle({ work }: { work: NativeWork }): boolean {
  const foregroundIdle = work.runningTurns.length === 0 && work.runningTools.length === 0
  const settled = work.unsettledInputs.length === 0 && work.pendingControls.length === 0
  const queueIdle = work.queue.knowledge === 'known' && work.queue.count === 0
  const backgroundIdle = work.background.knowledge === 'known' && work.background.tasks.length === 0

  return foregroundIdle && settled && queueIdle && backgroundIdle
}
