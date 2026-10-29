export function deferred<T>() {
  // eslint-disable-next-line pnyx/object-params -- Promise owns its resolver signature.
  let resolve!: (value: T | PromiseLike<T>) => void
  // eslint-disable-next-line pnyx/object-params -- Promise owns its rejection signature.
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((
    yes,
    no,
  ) => {
    resolve = yes; reject = no
  })

  return {
    promise,
    resolve,
    reject,
  }
}
