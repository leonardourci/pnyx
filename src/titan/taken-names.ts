import { hydraIds } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'
import { hydraConfig } from './config.ts'

// An unreadable Titan counts as none: a repeated name is harmless.
export function otherTitanNames({ id }: { id: string }): string[] {
  return hydraIds().filter(other => other !== id)
    .flatMap(other => {
      try {
        return [
          hydraConfig({
            state: loadTitan({ hydraId: other }).state,
            id: other,
          }).name,
        ]
      } catch {
        return []
      }
    })
}
