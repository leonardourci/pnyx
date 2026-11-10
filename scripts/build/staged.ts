import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const remove = ({ folder }: { folder: string }) => rmSync(
  folder,
  {
    recursive: true,
    force: true,
  },
)

// A build that fails or is killed leaves the last working dist: dist.next replaces it only after the build passed.
export function stagedBuild({
  root,
  build,
}: {
  root: string
  build({ out }: { out: string }): void
}) {
  const live = join(
    root,
    'dist',
  )
  const staged = join(
    root,
    'dist.next',
  )
  const previous = join(
    root,
    'dist.old',
  )

  remove({ folder: staged })

  try {
    build({ out: staged })
    remove({ folder: previous })

    if (existsSync(live)) {
      renameSync(
        live,
        previous,
      )
    }

    renameSync(
      staged,
      live,
    )
  } finally {
    remove({ folder: staged })
  }

  remove({ folder: previous })
}
