export class NativePositions extends Map<string, number> {
  #newest = new Map<number, string>()

  constructor({ entries = [] }: { entries?: Iterable<readonly [string, number]> } = {}) {
    super()

    for (const [
      id,
      position,
    ] of entries) {
      this.set(
        id,
        position,
      )
    }
  }

  newestIdAt({ position }: { position: number }): string | undefined {
    return this.#newest.get(position)
  }

  // eslint-disable-next-line othrys/object-params -- Map owns this signature.
  set(
    id: string,
    position: number,
  ): this {
    const previous = super.get(id)
    super.set(
      id,
      position,
    )

    if (previous === undefined) {
      this.#newest.set(
        position,
        id,
      )
    } else if (previous !== position) {
      this.#rescanNewest({ position: previous })
      this.#rescanNewest({ position })
    }

    return this
  }

  // eslint-disable-next-line othrys/object-params -- Map owns this signature.
  delete(id: string): boolean {
    const position = super.get(id)

    if (position === undefined) {
      return false
    }

    super.delete(id)

    if (this.#newest.get(position) === id) {
      this.#rescanNewest({ position })
    }

    return true
  }

  clear(): void {
    super.clear()
    this.#newest.clear()
  }

  #rescanNewest({ position }: { position: number }): void {
    let newest: string | undefined

    for (const [
      id,
      at,
    ] of this) {
      if (at === position) {
        newest = id
      }
    }

    if (newest === undefined) {
      this.#newest.delete(position)
    } else {
      this.#newest.set(
        position,
        newest,
      )
    }
  }
}
