import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { pnyxHome } from '#store/paths.ts'
import { HydraError } from '#store/errors.ts'
import { validatePolicy, type NativePolicy } from './native-policy.ts'

export const POLICY_PROFILE = 'pnyx-task'

export function policyConfiguration({ policy }: { policy: NativePolicy }): Record<string, unknown> {
  validatePolicy({ policy })
  const prefix = `permissions.${POLICY_PROFILE}`
  const config: Record<string, unknown> = {
    [`${prefix}.extends`]: ':read-only',
    [`${prefix}.filesystem.":root"`]: 'deny',
    [`${prefix}.filesystem.":minimal"`]: 'read',
    [`${prefix}.filesystem.":workspace_roots"`]: { '.': 'read' },
    [`${prefix}.network.enabled`]: false,
    [`${prefix}.network.allow_unix_sockets`]: [policy.brokerSocket],
    'experimental_network.allow_unix_sockets': [policy.brokerSocket],
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.set': policy.environment,
    'features.apps': false,
    'features.multi_agent': false,
    'features.js_repl': false,
    'web_search': 'disabled',
    'mcp_servers': {},
    'plugins': {},
    [`projects.${JSON.stringify(policy.readRoots[0])}.trust_level`]: 'untrusted',
  }

  for (const root of policy.readRoots) {
    config[`${prefix}.filesystem.${JSON.stringify(root)}`] = 'read'
  }

  for (const root of policy.writeRoots) {
    config[`${prefix}.filesystem.${JSON.stringify(root)}`] = 'write'
  }

  return config
}

const tomlValue = ({ value }: { value: unknown }): string => {
  if (Array.isArray(value)) {
    return `[${value.map(item => tomlValue({ value: item })).join(', ')}]`
  }

  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([
      key,
      item,
    ]) => `${JSON.stringify(key)} = ${tomlValue({ value: item })}`)
      .join(', ')} }`
  }

  return JSON.stringify(value)
}

export function policyArguments({ policy }: { policy: NativePolicy }): string[] {
  return Object.entries(policyConfiguration({ policy })).flatMap(([
    key,
    value,
  ]) => [
    '-c',
    `${key}=${tomlValue({ value })}`,
  ])
}

export function materializePolicy({ policy }: { policy: NativePolicy }) {
  const directory = join(
    pnyxHome(),
    'native-policies',
    policy.digest,
  )
  mkdirSync(
    directory,
    {
      recursive: true,
      mode: 0o700,
    },
  )
  const path = join(
    directory,
    'config.toml',
  )
  const text = Object.entries(policyConfiguration({ policy })).map(([
    key,
    value,
  ]) => `${key} = ${tomlValue({ value })}`)
    .join('\n') + '\n'

  if (existsSync(path) && readFileSync(
    path,
    'utf8',
  ) !== text) {
    throw new HydraError({
      code: 'POLICY_CHANGED',
      message: 'The frozen native policy bytes changed',
    })
  }

  if (!existsSync(path)) {
    writeFileSync(
      path,
      text,
      {
        flag: 'wx',
        mode: 0o400,
      },
    )
  }

  chmodSync(
    path,
    0o400,
  )

  return directory
}
