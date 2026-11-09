export const HISTORY_BUDGET = 6000

export function historyCommand({
  hydraId,
  since,
  through,
  budget = HISTORY_BUDGET,
}: {
  hydraId: string
  since: string
  through?: number
  budget?: number
}): string {
  const end = through === undefined ? '' : ` --through ${through}`

  return `pnyx-axi hydra history --hydra ${hydraId} --since ${since}${end} --budget ${budget}`
}
