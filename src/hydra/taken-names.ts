import { hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { hydraConfig } from './config.ts'

// An unreadable Hydra counts as none: a repeated name is harmless.
export function otherHydraNames({ id }: { id: string }): string[] {
  return hydraIds().filter(other => other !== id)
    .flatMap(other => {
      try {
        return [
          hydraConfig({
            state: loadHydra({ hydraId: other }).state,
            id: other,
          }).name,
        ]
      } catch {
        return []
      }
    })
}
