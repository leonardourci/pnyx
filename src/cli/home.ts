import { HOME_LIMIT, type Output } from '#app/cli-support.ts'
import { hideDone } from '#tasks/retention.ts'
import { DEFAULT_HYDRA } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { liveTask, rankOf } from '#tasks/select.ts'
import { hydraConfig } from '#hydra/config.ts'
import { readServer } from '#app/server-state.ts'
import { projectRows } from '#projects/read.ts'
import { spoolFiles } from '#store/storage.ts'
import type { Card } from '#tasks/model.ts'
import { cardRow } from '#tasks/cli.ts'
import { requestEnv } from '#app/request-context.ts'

export async function home(): Promise<Output> {
  const hydraId = requestEnv().PNYX_HYDRA || DEFAULT_HYDRA
  hideDone({ hydraId })
  const {
    dir,
    state,
  } = loadHydra({ hydraId })
  const cards = Object.values(state.cards).filter(card => liveTask({ card }))
  const config = hydraConfig({ state })
  const columns = Object.fromEntries(
    config.columns.map(c => [
      c.id,
      cards.filter(card => card.column === c.id).length,
    ]),
  )
  const server = await readServer({ hydraId })
  const out: Output = {
    projects: projectRows({ state }),
    hydraId,
    hydra: config.hydra.id,
    server: server ? `running at ${server.url}` : 'not running',
    columns,
  }

  const serveHint = server ? [] : [`Run \`pnyx-axi serve --hydra ${hydraId}\` to start the Hydra server`]
  const spooled = spoolFiles({ dir }).length

  if (spooled > 0) {
    out.spool = `${spooled} hook events waiting; the next write ingests them`
  }

  if (cards.length === 0) {
    out.cards = 'none: no cards yet'
    out.help = [
      `Run \`pnyx-axi task create --title <title> --hydra ${hydraId}\` to add work`,
      'Run `pnyx-axi --help` for command groups; add --help to any command for syntax',
      ...serveHint,
    ]

    return out
  }

  const order = ({ c }: { c: Card }) => config.columns.findIndex(column => column.id === c.column)
  const sorted = cards.sort((
    a,
    b,
  ) => order({
    c: a,
  }) - order({
    c: b,
  }) || rankOf({ card: a }) - rankOf({ card: b }))
  out.cards = sorted.slice(
    0,
    HOME_LIMIT,
  ).map(card => cardRow({
    state,
    card,
  }))
  out.help = [
    `Run \`pnyx-axi task show ${sorted[0]!.id} --hydra ${hydraId}\` for task details`,
    'Run `pnyx-axi --help` for command groups; add --help to any command for syntax',
    `Run \`pnyx-axi history --hydra ${hydraId}\` for recent events`,
    ...serveHint,
  ]

  if (sorted.length > HOME_LIMIT) {
    out.more = `${sorted.length - HOME_LIMIT} more cards not shown`
  }

  return out
}
