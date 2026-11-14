// A throwaway Pnyx folder whose fake pnpm runs the commit's own install.sh and build.sh, so a commit decides what fails.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const git = ({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}) => execFileSync(
  'git',
  [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    ...args,
  ],
  {
    cwd,
    encoding: 'utf8',
    stdio: [
      'ignore',
      'pipe',
      'pipe',
    ],
  },
).trim()

// A build that records its version and leaves a CLI whose data check (`setup postgres --check`) exits with dataExit.
export const building = ({
  version,
  dataExit = 0,
  fail = false,
  wait,
}: {
  version: string
  dataExit?: number
  fail?: boolean
  // A file the build waits for, so a test can act while it runs.
  wait?: string
}) => `${wait ? `while [ ! -f '${wait}' ]; do sleep 0.05; done\n` : ''}${fail ? 'echo "type error in build" >&2; exit 1\n' : ''}echo ${version} > built.txt
mkdir -p dist/cli
echo "process.stderr.write('data check ${dataExit}'); process.exit(${dataExit})" > dist/cli/pnyx-axi.js
`

export function upgradeFolder({ root }: { root: string }) {
  const bin = join(
    root,
    'upgrade-bin',
  )
  mkdirSync(
    bin,
    { recursive: true },
  )
  writeFileSync(
    join(
      bin,
      'pnpm',
    ),
    `#!/bin/sh
case "$1" in
  install) if [ -f install.sh ]; then exec sh install.sh; fi ;;
  run) exec sh "$2.sh" ;;
esac
`,
    { mode: 0o755 },
  )
  process.env.PATH = `${bin}:${process.env.PATH}`
  const origin = join(
    root,
    'pnyx-origin.git',
  )
  const author = join(
    root,
    'pnyx-author',
  )
  const install = join(
    root,
    'pnyx-install',
  )
  git({
    cwd: root,
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
    cwd: root,
    args: [
      'clone',
      '-q',
      origin,
      author,
    ],
  })
  git({
    cwd: author,
    args: [
      'checkout',
      '-q',
      '-b',
      'main',
    ],
  })

  // A commit on origin main, as a merged pull request leaves it.
  const publish = ({
    files,
    message,
  }: {
    files: Record<string, string>
    message: string
  }) => {
    for (const [
      name,
      text,
    ] of Object.entries(files)) {
      writeFileSync(
        join(
          author,
          name,
        ),
        text,
      )
    }

    git({
      cwd: author,
      args: [
        'add',
        '-A',
      ],
    })
    git({
      cwd: author,
      args: [
        'commit',
        '-q',
        '-m',
        message,
      ],
    })
    git({
      cwd: author,
      args: [
        'push',
        '-q',
        'origin',
        'main',
      ],
    })

    return git({
      cwd: author,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
  }

  const first = publish({
    files: {
      '.gitignore': 'built.txt\ndist/\n',
      'build.sh': building({ version: 'one' }),
    },
    message: 'one',
  })
  git({
    cwd: root,
    args: [
      'clone',
      '-q',
      origin,
      install,
    ],
  })
  execFileSync(
    'sh',
    ['build.sh'],
    { cwd: install },
  )

  // Puts origin and the install folder back on the first commit, its branch and its build, so every test starts from the same folder.
  const reset = () => {
    git({
      cwd: author,
      args: [
        'reset',
        '-q',
        '--hard',
        first,
      ],
    })
    git({
      cwd: author,
      args: [
        'push',
        '-q',
        '--force',
        'origin',
        'main',
      ],
    })
    git({
      cwd: install,
      args: [
        'fetch',
        '-q',
        'origin',
      ],
    })
    git({
      cwd: install,
      args: [
        'checkout',
        '-q',
        '-f',
        'main',
      ],
    })
    git({
      cwd: install,
      args: [
        'reset',
        '-q',
        '--hard',
        first,
      ],
    })
    git({
      cwd: install,
      args: [
        'clean',
        '-q',
        '-fd',
      ],
    })

    for (const branch of git({
      cwd: install,
      args: [
        'branch',
        '--format=%(refname:short)',
      ],
    }).split('\n')
      .filter(name => name && name !== 'main')) {
      git({
        cwd: install,
        args: [
          'branch',
          '-q',
          '-D',
          branch,
        ],
      })
    }

    // The mark an upgrade cut in the middle leaves.
    rmSync(
      join(
        install,
        git({
          cwd: install,
          args: [
            'rev-parse',
            '--git-path',
            'pnyx-upgrade-from',
          ],
        }),
      ),
      { force: true },
    )
    execFileSync(
      'sh',
      ['build.sh'],
      { cwd: install },
    )
  }

  return {
    install,
    first,
    publish,
    reset,
    head: () => git({
      cwd: install,
      args: [
        'rev-parse',
        'HEAD',
      ],
    }),
    built: () => readFileSync(
      join(
        install,
        'built.txt',
      ),
      'utf8',
    ).trim(),
  }
}
