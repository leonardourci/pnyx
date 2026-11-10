import { execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { stagedBuild } from './staged.ts'

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
          'cli/pnyx-axi.js',
        ),
        0o755,
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
