import { taskLeasePresent } from '#routine-helper/leases.ts'
import { HydraError } from '#store/errors.ts'

export const COPY_LEASE_PREFIX = 'copy-settlement:'

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
    throw new HydraError({
      message: `Task ${task} is settling its copy; try again when cleanup finishes`,
      code: 'CONFLICT',
    })
  }
}
