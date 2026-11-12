import { projectFolders, pluginInstallation } from './tool-scopes.ts'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { object } from './transcript-usage.ts'
import { HydraError } from '#store/errors.ts'

async function json({ path }: { path: string }): Promise<Record<string, unknown>> {
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

    throw new HydraError({
      message: `Cannot read tool configuration: ${path}`,
      code: 'TOOL_CONFIG_UNAVAILABLE',
    })
  }
}

function pluginRoot({
  value,
  root,
}: {
  value: unknown
  root: string
}): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(
      '${CLAUDE_PLUGIN_ROOT}',
      root,
    )
  }

  if (Array.isArray(value)) {
    return value.map(child => pluginRoot({
      value: child,
      root,
    }))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([
      key,
      child,
    ]) => [
      key,
      pluginRoot({
        value: child,
        root,
      }),
    ]))
  }

  return value
}

async function pluginMcp({
  id,
  root,
}: {
  id: string
  root: string
}): Promise<Record<string, unknown>> {
  const manifest = await json({
    path: join(
      root,
      '.claude-plugin',
      'plugin.json',
    ),
  })
  const bundled = await json({
    path: join(
      root,
      '.mcp.json',
    ),
  })
  const namespace = typeof manifest.name === 'string' ? manifest.name : id.split('@')[0]!

  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) {
    throw new HydraError({
      message: `Invalid installed plugin name: ${id}`,
      code: 'TOOL_CONFIG_UNAVAILABLE',
    })
  }

  const additions = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers]
  const sources = [bundled]

  for (const source of additions) {
    if (typeof source === 'string') {
      sources.push(await json({
        path: join(
          root,
          source,
        ),
      }))
    } else if (source && typeof source === 'object') {
      sources.push(object({ value: source }))
    }
  }

  const servers = Object.assign(
    {},
    ...sources.map(source => object({ value: source.mcpServers ?? source })),
  ) as Record<string, unknown>

  return Object.fromEntries(Object.entries(servers).map(([
    name,
    config,
  ]) => [
    `plugin_${namespace}_${name}`,
    pluginRoot({
      value: config,
      root,
    }),
  ]))
}

export async function claudeTools({
  cwd,
  env,
  grants = [],
}: {
  cwd: string
  env: NodeJS.ProcessEnv
  grants?: string[]
}) {
  const home = env.HOME ?? homedir()
  const folder = env.CLAUDE_CONFIG_DIR ?? join(
    home,
    '.claude',
  )
  const globalPath = env.CLAUDE_CONFIG_DIR ? join(
    folder,
    '.claude.json',
  ) : join(
    home,
    '.claude.json',
  )
  const folders = await projectFolders({ cwd })
  const [
    global,
    installed,
    ...settings
  ] = await Promise.all([
    json({ path: globalPath }),
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
  const servers = { ...object({ value: global.mcpServers }) }

  for (const folder of [...folders].reverse()) {
    const projectConfig = object({ value: object({ value: global.projects })[folder] })
    Object.assign(
      servers,
      object({ value: projectConfig.mcpServers }),
    )
    const project = await json({
      path: join(
        folder,
        '.mcp.json',
      ),
    })
    Object.assign(
      servers,
      object({ value: project.mcpServers }),
    )
  }

  const installedPlugins = object({ value: installed.plugins })
  const plugins = new Set([
    ...Object.keys(installedPlugins),
    ...settings.flatMap(setting => Object.keys(object({ value: setting.enabledPlugins }))),
  ])
  const catalog = [
    'browser',
    ...Object.keys(servers).map(name => `mcp:${name}`),
    ...Object.keys(installedPlugins).filter(name => pluginInstallation({
      value: installedPlugins[name],
      folders,
    }))
      .map(name => `plugin:${name}`),
  ].sort()

  for (const name of grants) {
    if (!catalog.includes(name)) {
      throw new HydraError({
        message: `Tool capability is not configured for this Claude login: ${name}`,
        code: 'TOOL_UNAVAILABLE',
      })
    }
  }

  const mcpServers = Object.fromEntries(Object.entries(servers).filter(([name]) => grants.includes(`mcp:${name}`))) as NonNullable<Options['mcpServers']>
  const localPlugins: NonNullable<Options['plugins']> = []

  for (const grant of grants.filter(name => name.startsWith('plugin:'))) {
    const id = grant.slice('plugin:'.length)
    const root = pluginInstallation({
      value: installedPlugins[id],
      folders,
    })!
    const bundled = await pluginMcp({
      id,
      root,
    })

    for (const [
      name,
      server,
    ] of Object.entries(bundled)) {
      if (Object.hasOwn(
        mcpServers,
        name,
      )) {
        throw new HydraError({
          message: `Tool server name is ambiguous: ${name}`,
          code: 'TOOL_CONFIG_CONFLICT',
        })
      }

      mcpServers[name] = server as NonNullable<Options['mcpServers']>[string]
    }

    localPlugins.push({
      type: 'local',
      path: root,
      skipMcpDiscovery: true,
    })
  }

  const enabledPlugins = Object.fromEntries([...plugins].map(name => [
    name,
    false,
  ]))

  return {
    catalog,
    mcpServers,
    enabledPlugins,
    localPlugins,
  }
}
