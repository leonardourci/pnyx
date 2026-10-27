export function background({
  name,
  run,
  retry,
}: {
  name: string
  run(): unknown
  retry?(): void
}): void {
  const failed = ({ error }: { error: unknown }) => {
    console.error(
      `pnyx-axi ${name}:`,
      error,
    )

    try {
      retry?.()
    } catch (error) {
      console.error(
        `pnyx-axi ${name} retry:`,
        error,
      )
    }
  }

  try {
    void Promise.resolve(run()).catch(error => failed({ error }))
  } catch (error) {
    failed({ error })
  }
}
