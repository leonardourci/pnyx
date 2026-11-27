// Saving a decision turns every sequence field back into a native id, so the id at each position is indexed, not searched.
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

  // The id recorded last at this position, in insertion order, as a backwards search of the entries would find it.
  idAt({ position }: { position: number }): string | undefined {
    return this.#newest.get(position)
  }

  // eslint-disable-next-line othrys/object-params -- Map owns this signature.
  set(
    id: string,
    position: number,
  ): this {
    const known = super.has(id)
    const previous = super.get(id)
    super.set(
      id,
      position,
    )

    if (!known) {
      this.#inserted.set(
        id,
        this.#count++,
      )
    }

    if (known && previous === position) {
      return this
    }

    if (previous !== undefined && this.#newest.get(previous) === id) {
      this.#refresh({ position: previous })
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

    if (!super.delete(id)) {
      return false
    }

    this.#inserted.delete(id)

    if (this.#newest.get(position!) === id) {
      this.#refresh({ position: position! })
    }

    return true
  }

  clear(): void {
    super.clear()
    this.#inserted.clear()
    this.#newest.clear()
  }

  // Rare: only a re-recorded or deleted entry rescans for the next newest id at its old position.
  #refresh({ position }: { position: number }): void {
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
