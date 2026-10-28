import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import type { Harness } from './dispatch-config.ts'
import { pnyxHome } from '../store/storage.ts'
import { modelIds, type ModelOption } from './provider.ts'
import type { Host } from '../app/host-types.ts'

export const providerName = ({ harness }: { harness: Harness }) => harness === 'codex' ? 'codex' : 'claude-code'

const modelsPath = () => join(
  pnyxHome(),
  'harness-models.json',
)

// "<harness>:<login folder>" -> the harness's model list, shared by every Hydra.
function readModels(): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(
      modelsPath(),
      'utf8',
    )) as unknown

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function storedModels({ key }: { key: string }): ModelOption[] | undefined {
  const value = readModels()[key]
  const models = (Array.isArray(value) ? value as Partial<ModelOption>[] : [])
    .filter((model): model is ModelOption => typeof model?.value === 'string' && typeof model.label === 'string')

  return models.length > 0 ? models : undefined
}

// ponytail: read-modify-write without a lock, so two servers storing at once can drop one key; it is read again on the next start.
export function storeModels({
  key,
  models,
}: {
  key: string
  models: ModelOption[]
}): void {
  const tmp = `${modelsPath()}.tmp-${process.pid}`

  // The stored list only saves the next read; failing to write it never fails this one.
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        ...readModels(),
        [key]: models,
      }),
    )
    renameSync(
      tmp,
      modelsPath(),
    )
  } catch {
    rmSync(
      tmp,
      { force: true },
    )
  }
}

// A harness whose catalog cannot be read is left out, so its models are not checked.
export async function catalogOffers({
  host,
  harnesses,
}: {
  host: Host
  harnesses: Harness[]
}) {
  const offers: Partial<Record<Harness, string[]>> = {}

  await Promise.all([...new Set(harnesses)].map(harness => host.models({ harness })
    .then(
      models => {
        offers[harness] = modelIds({ models })
      },
      () => {},
    )))

  return offers
}
