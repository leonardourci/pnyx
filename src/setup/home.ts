import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inform } from '#app/command-notices.ts'
import { canonical, othrysHome } from '#store/paths.ts'

export function requireSetupHome({ allowCustomHome }: { allowCustomHome: boolean }) {
  const home = canonical({ path: resolve(othrysHome()) })
  const defaultHome = canonical({
    path: join(
      homedir(),
      '.othrys',
    ),
  })

  if (allowCustomHome || home === defaultHome) {
    return
  }

  inform({
    reason: `Setup changes user-wide configuration for custom home ${home}`,
    clear: 'Use othrys setup --preview to inspect the installation or othrys setup --remove to remove it',
  })
}
