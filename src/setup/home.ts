import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inform } from '#app/command-notices.ts'
import { canonical, pnyxHome } from '#store/paths.ts'

export function requireSetupHome({ allowCustomHome }: { allowCustomHome: boolean }) {
  const home = canonical({ path: resolve(pnyxHome()) })
  const defaultHome = canonical({
    path: join(
      homedir(),
      '.pnyx',
    ),
  })

  if (allowCustomHome || home === defaultHome) {
    return
  }

  inform({
    reason: `Setup changes user-wide configuration for custom home ${home}`,
    clear: 'Use pnyx-axi setup --help to inspect or remove the installation',
  })
}
