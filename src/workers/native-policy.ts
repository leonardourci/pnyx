import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { materializePolicy, POLICY_PROFILE } from './native-policy-files.ts'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { HydraError } from '#store/errors.ts'

export type NativePolicy = {
  grant: string
  revision: number
  digest: string
  readRoots: string[]
  writeRoots: string[]
  environment: Record<string, string>
  brokerSocket: string
}
export type NativePolicyReceipt = {
  grant: string
  revision: number
  digest: string
  incarnation: string
  status: 'applied' | 'unavailable' | 'stopped'
  reason?: string
}
const TOOLS = [
  'Bash',
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'AskUserQuestion',
]
const WRITE_TOOLS = [
  'Edit',
  'Write',
]
const PATH_FIELDS = [
  'file_path',
  'path',
  'notebook_path',
]

export function policyDigest({ policy }: { policy: Omit<NativePolicy, 'digest'> }) {
  return createHash('sha256').update(JSON.stringify(policy))
    .digest('hex')
}

export function validatePolicy({ policy }: { policy: NativePolicy }) {
  const {
    digest,
    ...compiled
  } = policy

  if (process.platform !== 'darwin' || !policy.grant || !Number.isSafeInteger(policy.revision) || policy.revision < 1
    || digest !== policyDigest({ policy: compiled }) || !isAbsolute(policy.brokerSocket)
    || !policy.readRoots.every(isAbsolute) || !policy.writeRoots.every(isAbsolute)) {
    throw new HydraError({
      code: 'POLICY_UNAVAILABLE',
      message: 'This native policy requires the proven macOS capability profile and an intact resolved digest',
    })
  }
}

const inside = ({
  path,
  roots,
}: {
  path: string
  roots: string[]
}) => roots.some(root => {
  const suffix = relative(
    root,
    path,
  )

  return suffix === '' || !suffix.startsWith('..') && !isAbsolute(suffix)
})
const quote = ({ value }: { value: string }) => `'${value.replaceAll(
  "'",
  "'\\''",
)}'`

export function toolCeiling({
  policy,
  tool,
  input,
}: {
  policy: NativePolicy
  tool: string
  input: Record<string, unknown>
}):
  {
    allowed: true
    input: Record<string, unknown>
  } | {
    allowed: false
    reason: string
  } {
  if (!TOOLS.includes(tool) || input.dangerouslyDisableSandbox === true) {
    return {
      allowed: false,
      reason: 'This tool is outside the native capability ceiling',
    }
  }

  if (tool === 'Bash') {
    if (typeof input.command !== 'string') {
      return {
        allowed: false,
        reason: 'Expected a shell command',
      }
    }

    const environment = Object.entries(policy.environment).map(([
      name,
      value,
    ]) => `${name}=${quote({ value })}`)
      .join(' ')
    const home = materializePolicy({ policy })

    return {
      allowed: true,
      input: {
        ...input,
        command: `/usr/bin/env -i PATH=/opt/homebrew/bin:/usr/bin:/bin CODEX_HOME=${quote({ value: home })} codex sandbox -P ${POLICY_PROFILE} --allow-unix-socket ${quote({ value: policy.brokerSocket })} -- /usr/bin/env -i ${environment} /bin/sh -c ${quote({ value: input.command })}`,
      },
    }
  }

  const writes = WRITE_TOOLS.includes(tool)
  const roots = writes ? policy.writeRoots : policy.readRoots

  if (writes && roots.length === 0) {
    return {
      allowed: false,
      reason: 'The task is read-only',
    }
  }

  if (tool !== 'AskUserQuestion') {
    for (const field of PATH_FIELDS) {
      const value = input[field]

      if (typeof value !== 'string') {
        continue
      }

      let path = resolve(
        policy.readRoots[0]!,
        value,
      )

      try {
        path = realpathSync(path)
      } catch {
        // New files are checked against their resolved parent before a write.
        const slash = path.lastIndexOf('/')

        try {
          path = `${realpathSync(path.slice(
            0,
            slash,
          ))}/${path.slice(slash + 1)}`
        } catch {
          return {
            allowed: false,
            reason: 'The path cannot be resolved inside the task roots',
          }
        }
      }

      if (!isAbsolute(path) || !inside({
        path,
        roots,
      })) {
        return {
          allowed: false,
          reason: 'The path is outside the task roots',
        }
      }
    }
  }

  return {
    allowed: true,
    input,
  }
}

export function claudePolicyOptions({ policy }: { policy: NativePolicy }): Partial<Options> {
  validatePolicy({ policy })

  return {
    settingSources: [],
    plugins: [],
    mcpServers: {},
    tools: TOOLS,
    allowedTools: TOOLS,
    allowDangerouslySkipPermissions: false,
    permissionMode: 'default',
    // Bash is wrapped in the same frozen kernel profile used by Codex, avoiding provider-default write roots.
    sandbox: {
      enabled: false,
      allowUnsandboxedCommands: false,
    },
  }
}

export function policyReceipt({
  policy,
  incarnation,
}: {
  policy: NativePolicy
  incarnation: string
}): NativePolicyReceipt {
  return {
    grant: policy.grant,
    revision: policy.revision,
    digest: policy.digest,
    incarnation,
    status: 'applied',
  }
}

export function fenceSetting({
  policy,
  setting,
}: {
  policy?: NativePolicy
  setting: string
}) {
  if (policy && setting === 'mode') {
    throw new HydraError({
      code: 'POLICY_CEILING',
      message: 'A live setting cannot replace the confirmed native policy',
    })
  }
}
