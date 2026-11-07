import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { effectiveDispatch, loginFolder, type Harness } from './dispatch-config.ts'
import { pnyxHome } from '#store/storage.ts'
import { modelIds, type HostedSession, type ModelOption, type Provider } from './provider.ts'
import { HARNESSES, harnessOf, providerIdOf, type ProviderId } from './providers.ts'
import type { Host } from '#app/host-types.ts'
import { loadHydra } from '#app/store.ts'
import { hydraDir } from '#app/home-migration.ts'
import { accountEnv } from './dispatch.ts'
import { accountFor } from './account-choice.ts'
import { sessionId } from './session-attachments.ts'

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

// Every model each harness listed on any login, for warnings about a model no login offers.
export function storedOffers(): Partial<Record<Harness, string[]>> {
  const offers: Partial<Record<Harness, string[]>> = {}

  for (const harness of HARNESSES) {
    const models = Object.keys(readModels()).filter(key => key.startsWith(`${harness}:`))
      .flatMap(key => storedModels({ key }) ?? [])

    if (models.length) {
      offers[harness] = modelIds({ models })
    }
  }

  return offers
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

type CommandSuggestion = {
  command: string
  description: string
  source: string
  kind: 'command'
}

// The agent commands and model lists the composer and pickers offer, cached per harness, login and folder.
export function createCatalogs({
  hydraId,
  providers,
  liveSession,
  closing,
  environment,
  saveCatalog,
}: {
  hydraId: string
  providers: Record<ProviderId, Provider>
  liveSession({ key }: { key: string }): HostedSession | undefined
  closing(): boolean
  environment(): NodeJS.ProcessEnv
  saveCatalog({
    card,
    key,
    commands,
  }: {
    card: string
    key: string
    commands: CommandSuggestion[]
  }): void
}) {
  const modelCatalogs = new Map<string, Promise<ModelOption[]>>()
  const commandCatalogs = new Map<string, CommandSuggestion[]>()

  const commands: Host['catalogCommands'] = async ({
    card,
    provider = card.agent?.provider ?? 'claude-code',
  }) => {
    const harness = providerIdOf({ harness: harnessOf({ provider }) })
    const cacheKey = JSON.stringify([
      harness,
      card.agent?.loginFolder,
      card.agent?.cwd ?? card.folder,
    ])

    const retained = () => {
      const saved = loadHydra({ hydraId }).state.cards[card.id]?.compaction?.catalogs
      const commands = commandCatalogs.get(cacheKey) ?? saved?.[cacheKey] ?? []
      const matches = card.agent?.provider === harness
      const session = matches && card.agent ? sessionId({ agent: card.agent }) : undefined
      const operation = loadHydra({ hydraId }).state.cards[card.id]?.compaction?.operations
        .findLast(operation => operation.session === session)
      const unavailable = operation?.state === 'failed' && operation.unsupported ? operation.error : undefined
      const native = commands.some(item => item.command === '/compact') || !providers[harness].compact ? commands : [
        ...commands,
        {
          command: '/compact',
          description: 'Compact the conversation',
          source: 'Agent commands',
          kind: 'command' as const,
        },
      ]

      return native.map(item => item.command === '/compact' && unavailable ? {
        ...item,
        unavailable,
        description: `Unavailable: ${unavailable}`,
      } : item)
    }

    const matchesProvider = card.agent?.provider === harness
    const session = matchesProvider && card.agent ? sessionId({ agent: card.agent }) : undefined
    const running = session ? liveSession({ key: session }) : undefined

    if (!running?.commands) {
      return retained()
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      const lookup = running.commands().then(commands => {
        const found = commands.filter(item => item.builtin).map(item => ({
          command: `/${item.name}`,
          description: item.description,
          source: 'Agent commands',
          kind: 'command' as const,
        }))

        if (found.length && !closing()) {
          commandCatalogs.set(
            cacheKey,
            found,
          )
          const saved = loadHydra({ hydraId }).state.cards[card.id]?.compaction?.catalogs
          const previous = saved?.[cacheKey]

          if (JSON.stringify(previous) !== JSON.stringify(found)) {
            saveCatalog({
              card: card.id,
              key: cacheKey,
              commands: found,
            })
          }
        }
      })
      await Promise.race([
        lookup,
        new Promise<void>(resolve => {
          timer = setTimeout(
            resolve,
            100,
          )
        }),
      ])

      return retained()
    } catch {
      // The disk index remains usable when the native command list is unavailable.
      return retained()
    } finally {
      clearTimeout(timer)
    }
  }

  const models: Host['models'] = async ({
    harness,
    account: selectedAccount,
  }) => {
    const { account } = accountFor({
      effective: effectiveDispatch(),
      harness,
      prefer: selectedAccount,
    })
    const env = accountEnv({
      account,
      env: environment(),
    })

    const key = `${harness}:${account ? loginFolder({ account }) : ''}`
    let catalog = modelCatalogs.get(key)

    if (!catalog) {
      const provider = providers[providerIdOf({ harness })]
      const cwd = hydraDir({ hydraId })
      const stored = storedModels({ key })

      // The folder's own settings apply on top of the shared list; a failed read is dropped so the picker can retry.
      const settle = ({ models }: { models: ModelOption[] | Promise<ModelOption[]> }) => {
        const settled = Promise.resolve(models)
          .then(models => provider.defaults({
            cwd,
            env,
            models,
          }))
        modelCatalogs.set(
          key,
          settled,
        )
        void settled.catch(() => {
          if (modelCatalogs.get(key) === settled) {
            modelCatalogs.delete(key)
          }
        })

        return settled
      }

      // The harness is read once per server; a stored list answers meanwhile and a failed read keeps it.
      const read = provider.models({
        cwd,
        env,
      }).then(models => {
        const changed = JSON.stringify(models) !== JSON.stringify(stored)

        if (changed) {
          storeModels({
            key,
            models,
          })
        }

        if (changed && stored) {
          void settle({ models })
        }

        return models
      })
      void read.catch(() => {})
      catalog = settle({ models: stored ?? read })
    }

    return catalog
  }

  return {
    commands,
    models,
  }
}
