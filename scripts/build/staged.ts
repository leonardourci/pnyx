import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Each build stages in its own folder, named after its process, so two builds never share one.
const STAGED_PREFIX = 'dist.next.'

const remove = ({ folder }: { folder: string }) => rmSync(
  folder,
  {
    recursive: true,
    force: true,
  },
)

function running({ pid }: { pid: number }) {
  try {
    process.kill(
      pid,
      0,
    )

    return true
  } catch (error) {
    // Another user's process refuses the signal but exists.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// A build that fails or is killed leaves the last working dist: its staged folder replaces dist only after the build passed.
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
    `${STAGED_PREFIX}${process.pid}`,
  )
  const previous = join(
    root,
    'dist.old',
  )

  // A build killed between the two renames below left the last working build here.
  if (!existsSync(live) && existsSync(previous)) {
    renameSync(
      previous,
      live,
    )
  }

  for (const name of readdirSync(root)) {
    const builder = Number(name.slice(STAGED_PREFIX.length))
    const abandoned = name.startsWith(STAGED_PREFIX) && !running({ pid: builder })

    if (abandoned) {
      remove({
        folder: join(
          root,
          name,
        ),
      })
    }
  }

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
