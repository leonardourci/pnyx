import { COPY_LEASE_PREFIX, copySettlingRefusal, taskLeasePresent } from '#routine-helper/leases.ts'

export { COPY_LEASE_PREFIX }

export function copySettling({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}): boolean {
  return taskLeasePresent({
    hydraId,
    task,
    actorPrefix: COPY_LEASE_PREFIX,
  })
}

export function requireCopyAvailable({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}): void {
  if (copySettling({
    hydraId,
    task,
  })) {
    throw copySettlingRefusal({
      hydraId,
      task,
      code: 'CONFLICT',
    })
  }
}
