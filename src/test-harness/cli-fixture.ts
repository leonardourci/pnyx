import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HydraState } from '../core/model.ts'

// Text assertions use stable fixture names while production IDs remain random.
export function fixtureCli({
  home,
  execute,
}: {
  home: string
  execute({ args }: { args: string[] }): string
}) {
  const aliases = () => {
    const path = join(
      home,
      'hydras/default/snapshot.json',
    )
    const state = existsSync(path) ? (JSON.parse(readFileSync(
      path,
      'utf8',
    )) as { state: HydraState }).state : undefined

    return Object.values(state?.cards ?? {}).filter(c => !c.id.startsWith('$'))
      .map(c => ({
        name: `c${c.createdSeq}`,
        id: c.id,
      }))
  }

  return ({ args = [] }: { args?: string[] } = {}) => {
    const ids = aliases()
    let out = execute({ args: args.map(arg => ids.find(c => c.name === arg)?.id ?? arg) })

    for (const {
      name,
      id,
    } of aliases()) {
      out = out.replaceAll(
        id,
        name,
      )
    }

    return out
  }
}
