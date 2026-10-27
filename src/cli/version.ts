import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

// A leaf module: `--version` reads it before the command graph loads.
export const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }

// The version and the installed commit, the one place Pnyx shows which commit it runs.
export function installedVersion(): string {
  try {
    return `${version} (${execFileSync(
      'git',
      [
        'rev-parse',
        '--short=7',
        'HEAD',
      ],
      {
        cwd: import.meta.dirname,
        encoding: 'utf8',
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
      },
    ).trim()})`
  } catch {
    return version
  }
}
