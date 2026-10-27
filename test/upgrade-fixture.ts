import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const building = ({ version }: { version: string }) => `echo ${version} > built.txt\n`

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

// A throwaway Pnyx folder cloned from its own bare origin, built once. Its pnpm, put first on PATH, runs install.sh and <script>.sh from the folder, so a published commit decides what fails.
export function upgradeRepo({ root }: { root: string }) {
  const dir = mkdtempSync(join(
    root,
    'case-',
  ))
  const bin = join(
    root,
    'bin',
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

  if (!process.env.PATH!.startsWith(`${bin}:`)) {
    process.env.PATH = `${bin}:${process.env.PATH}`
  }

  const origin = join(
    dir,
    'origin.git',
  )
  const author = join(
    dir,
    'author',
  )
  const install = join(
    dir,
    'install',
  )

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

    for (const args of [
      [
        'add',
        '-A',
      ],
      [
        'commit',
        '-m',
        message,
      ],
      [
        'push',
        'origin',
        'main',
      ],
    ]) {
      git({
        cwd: author,
        args,
      })
    }

    return git({
      cwd: author,
      args: [
        'rev-parse',
        'HEAD',
      ],
    })
  }

  git({
    cwd: dir,
    args: [
      'init',
      '--bare',
      '-b',
      'main',
      origin,
    ],
  })
  git({
    cwd: dir,
    args: [
      'clone',
      origin,
      author,
    ],
  })
  git({
    cwd: author,
    args: [
      'checkout',
      '-b',
      'main',
    ],
  })
  publish({
    files: {
      '.gitignore': 'built.txt\n',
      'build.sh': building({ version: 'one' }),
    },
    message: 'one',
  })
  git({
    cwd: dir,
    args: [
      'clone',
      origin,
      install,
    ],
  })
  execFileSync(
    'sh',
    ['build.sh'],
    { cwd: install },
  )

  return {
    install,
    publish,
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
