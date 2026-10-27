export class HydraError extends Error {
  code: string
  help: string[]
  constructor({
    message,
    code,
    help = [],
  }: {
    message: string
    code: string
    help?: string[]
  }) {
    super(message)
    this.code = code
    this.help = help
  }
}
