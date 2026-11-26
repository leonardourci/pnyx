import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stagedBuild } from './staged.ts'

const EXECUTABLE_MODE = 0o755

const root = join(
  import.meta.dirname,
  '..',
  '..',
)

const run = ({
  command,
  args,
  env = process.env,
}: {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}) => execFileSync(
  command,
  args,
  {
    cwd: root,
    stdio: 'inherit',
    env,
  },
)

try {
  stagedBuild({
    root,
    build: ({ out }) => {
      run({
        command: 'tsc',
        args: [
          '-p',
          'tsconfig.build.json',
          '--outDir',
          out,
        ],
      })
      chmodSync(
        join(
          out,
          'cli/othrys.js',
        ),
        EXECUTABLE_MODE,
      )

      const alias = join(
        out,
        'cli/othrys-axi.js',
      )
      writeFileSync(
        alias,
        "#!/usr/bin/env node\nimport './othrys.js'\n",
      )
      chmodSync(
        alias,
        EXECUTABLE_MODE,
      )

      run({
        command: 'vite',
        args: [
          'build',
          '--configLoader',
          'native',
          '--config',
          'web/vite.config.ts',
          '--outDir',
          join(
            out,
            'web',
          ),
        ],
        env: {
          ...process.env,
          NODE_OPTIONS: '--conditions=source',
        },
      })
    },
  })
} catch (error) {
  // The failed command already printed why; a stack trace would push that out of the last lines an upgrade reports.
  console.error((error as Error).message)
  process.exitCode = 1
}
