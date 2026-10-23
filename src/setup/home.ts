import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { HydraError } from '../core/model.ts'
import { canonical, pnyxHome } from '../store/paths.ts'

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

  throw new HydraError({
    message: `setup changes user-wide configuration, but PNYX_HOME points to a non-default home: ${home}`,
    code: 'CUSTOM_HOME_SETUP',
    help: [
      'Unset PNYX_HOME to install for the default home',
      'Pass --allow-custom-home to explicitly install or remove user-wide setup for this home',
    ],
  })
}
