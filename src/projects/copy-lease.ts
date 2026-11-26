import { COPY_LEASE_PREFIX, copySettlingRefusal, taskLeasePresent } from '#routine-helper/leases.ts'

export { COPY_LEASE_PREFIX }

export function copySettling({
  titanId,
  task,
}: {
  titanId: string
  task: string
}): boolean {
  return taskLeasePresent({
    titanId,
    task,
    actorPrefix: COPY_LEASE_PREFIX,
  })
}

export function requireCopyAvailable({
  titanId,
  task,
}: {
  titanId: string
  task: string
}): void {
  if (copySettling({
    titanId,
    task,
  })) {
    throw copySettlingRefusal({
      titanId,
      task,
      code: 'CONFLICT',
    })
  }
}
