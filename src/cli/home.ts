import { HOME_LIMIT, type Output } from '#app/cli-support.ts'
import { hideDone } from '#tasks/retention.ts'
import { DEFAULT_TITAN } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'
import { liveTask, rankOf } from '#tasks/select.ts'
import { hydraConfig } from '#titan/config.ts'
import { readServer } from '#app/server-state.ts'
import { projectRows } from '#projects/read.ts'
import { spoolFiles } from '#store/storage.ts'
import { cardRow } from '#tasks/cli.ts'

export async function home({ hydraId = DEFAULT_TITAN }: { hydraId?: string }): Promise<Output> {
  await hideDone({ hydraId })
  const {
    dir,
    state,
  } = loadTitan({ hydraId })
  const cards = Object.values(state.cards).filter(card => liveTask({ card }))
  const config = hydraConfig({ state })
  const server = await readServer({ hydraId })
  const out: Output = {
    projects: projectRows({ state }),
    hydraId,
    hydra: config.hydra.id,
    server: server ? `running at ${server.url}` : 'not running',
  }

  const spooled = spoolFiles({ dir }).length

  if (spooled > 0) {
    out.spool = `${spooled} hook events waiting; the next write ingests them`
  }

  if (cards.length === 0) {
    out.cards = 'none: no cards yet'

    return out
  }

  const sorted = cards.sort((
    a,
    b,
  ) => (a.project ?? '').localeCompare(b.project ?? '') || rankOf({ card: a }) - rankOf({ card: b }))
  out.cards = sorted.slice(
    0,
    HOME_LIMIT,
  ).map(card => cardRow({
    state,
    card,
  }))

  if (sorted.length > HOME_LIMIT) {
    out.more = `${sorted.length - HOME_LIMIT} more cards not shown`
  }

  return out
}
