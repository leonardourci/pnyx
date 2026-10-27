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
