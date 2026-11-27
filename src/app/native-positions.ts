export class NativePositions extends Map<string, number> {
  #inserted = new Map<string, number>()
  #newest = new Map<number, string>()
  #count = 0

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

    if (previous === position) {
      return this
    }

    if (previous === undefined) {
      this.#inserted.set(
        id,
        this.#count++,
      )
    } else if (this.#newest.get(previous) === id) {
      this.#rescanNewest({ position: previous })
    }

    const holder = this.#newest.get(position)

    if (holder === undefined || this.#inserted.get(holder)! < this.#inserted.get(id)!) {
      this.#newest.set(
        position,
        id,
      )
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
    this.#inserted.delete(id)

    if (this.#newest.get(position) === id) {
      this.#rescanNewest({ position })
    }

    return true
  }

  clear(): void {
    super.clear()
    this.#inserted.clear()
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
