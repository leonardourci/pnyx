import { titanIds } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'
import { titanConfig } from './config.ts'

// An unreadable Titan counts as none: a repeated name is harmless.
export function otherTitanNames({ id }: { id: string }): string[] {
  return titanIds().filter(other => other !== id)
    .flatMap(other => {
      try {
        return [
          titanConfig({
            state: loadTitan({ titanId: other }).state,
            id: other,
          }).name,
        ]
      } catch {
        return []
      }
    })
}
