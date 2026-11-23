import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hydra } from './pnyx.ts'
import { git } from './upgrade.ts'

// A git project with one commit on main, attached with this landing rule; without a remote it gets a local bare origin.
export const createProject = async ({
  hydra,
  landing,
  remote,
  name = 'shop',
}: {
  hydra: Hydra
  landing: 'branch' | 'pr'
  remote?: string
  name?: string
}) => {
  const path = hydra.folder({ name })
  const origin = remote ?? `${path}.git`
  const steps = [
    [
      'init',
      '-q',
      '-b',
      'main',
    ],
    [
      'add',
      '.',
    ],
    [
      'commit',
      '-q',
      '-m',
      'init',
    ],
    [
      'remote',
      'add',
      'origin',
      origin,
    ],
  ]
  writeFileSync(
    join(
      path,
      'README.md',
    ),
    'shop\n',
  )

  for (const args of steps) {
    git({
      cwd: path,
      args,
    })
  }

  if (!remote) {
    git({
      cwd: path,
      args: [
        'init',
        '-q',
        '--bare',
        '-b',
        'main',
        origin,
      ],
    })
    git({
      cwd: path,
      args: [
        'push',
        '-q',
        'origin',
        'main',
      ],
    })
  }

  await hydra.owner({
    args: [
      'project',
      'add',
      path,
      '--landing',
      landing,
    ],
  })

  return path
}
