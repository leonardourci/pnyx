import { HydraError } from '#store/errors.ts'
import { memoryAccessRevision } from './poleis.ts'

const MEMORY_CONTEXT_ATTEMPTS = 3

export async function readMemoryContext<T>({ read }: { read(): Promise<T> }): Promise<T> {
  for (let attempt = 0; attempt < MEMORY_CONTEXT_ATTEMPTS; attempt++) {
    const revision = memoryAccessRevision()

    try {
      const result = await read()

      if (revision === memoryAccessRevision()) {
        return result
      }
    } catch (error) {
      if (error instanceof HydraError && error.code === 'NOT_FOUND' && revision !== memoryAccessRevision()) {
        continue
      }

      throw error
    }
  }

  throw new HydraError({
    message: 'Memory access kept changing; retry the command',
    code: 'CONFLICT',
  })
}
