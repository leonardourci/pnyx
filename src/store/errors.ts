// What the Postgres worker reports when a conditional write matched another row count.
export const CONFLICT_CODE = 'PNYX_CONFLICT'

export class HydraError extends Error {
  code: string
  help: string[]
  field?: string
  constructor({
    message,
    code,
    help = [],
    field,
  }: {
    message: string
    code: string
    help?: string[]
    field?: string
  }) {
    super(message)
    this.code = code
    this.help = help
    this.field = field
  }
}

export function inField<T>({
  field,
  read,
}: {
  field: string
  read(): T
}): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof HydraError && error.field === undefined) {
      error.field = field
    }

    throw error
  }
}
