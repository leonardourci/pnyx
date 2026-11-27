// Generated ids share a namespace with caller-chosen ones, so skip any already used.
export function freeId({
  used,
  seq,
}: {
  used: Record<string, number>
  seq: number
}): string {
  let id = `evt_${seq}`

  for (let n = 2; id in used; n++) {
    id = `evt_${seq}_${n}`
  }

  return id
}

export function generatedSeq({ id }: { id: string }): number {
  const generated = /^evt_(\d+)(?:_\d+)?$/.exec(id)
  const seq = Number(generated?.[1])

  return Number.isSafeInteger(seq) ? seq : 0
}
