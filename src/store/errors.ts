export class TitanError extends Error {
  code: string
  help: string[]
  field?: string
  constructor({
    message,
    code,
    help = [],
    field,
    cause,
  }: {
    message: string
    code: string
    help?: string[]
    field?: string
    cause?: unknown
  }) {
    super(
      message,
      { cause },
    )
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
    if (error instanceof TitanError && error.field === undefined) {
      error.field = field
    }

    throw error
  }
}
