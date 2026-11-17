import { projectFolders } from './tool-scopes.ts'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { object } from './transcript-usage.ts'
import { log } from '#app/diagnostics.ts'

async function json({
  path,
}: {
  path: string
}): Promise<Record<string, unknown>> {
  try {
    return object({
      value: JSON.parse(await readFile(
        path,
        'utf8',
      )),
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }

    const message = `Cannot read tool configuration: ${path}: ${(error as Error).message}`

    log({
      level: 'warn',
      operation: 'tools.config',
      error: message,
    })

    return {}
  }
}

export async function claudeTools({
  cwd,
  env,
}: {
  cwd: string
  env: NodeJS.ProcessEnv
}) {
  const home = env.HOME ?? homedir()
  const folder = env.CLAUDE_CONFIG_DIR ?? join(
    home,
    '.claude',
  )
  const folders = await projectFolders({ cwd })
  const [
    installed,
    ...settings
  ] = await Promise.all([
    json({
      path: join(
        folder,
        'plugins',
        'installed_plugins.json',
      ),
    }),
    json({
      path: join(
        folder,
        'settings.json',
      ),
    }),
    ...[...folders].reverse().flatMap(folder => [
      'settings.json',
      'settings.local.json',
    ].map(file => json({
      path: join(
        folder,
        '.claude',
        file,
      ),
    }))),
  ])
  const installedPlugins = object({ value: installed.plugins })
  const plugins = new Set([
    ...Object.keys(installedPlugins),
    ...settings.flatMap(setting => Object.keys(object({ value: setting.enabledPlugins }))),
  ])
  const enabledPlugins = Object.fromEntries([...plugins].map(name => [
    name,
    false,
  ]))

  return {
    enabledPlugins,
  }
}
