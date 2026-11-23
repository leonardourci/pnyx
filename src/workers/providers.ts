// Each harness Othrys runs: its provider id in agent records, the name people see, how its skills are invoked
// and the ask mode it runs in when none is set.
export const PROVIDERS = {
  claude: {
    provider: 'claude-code',
    name: 'Claude Code',
    usageName: 'Claude',
    icon: 'claude-code',
    skillPrefix: '/',
    defaultMode: 'default',
  },
  codex: {
    provider: 'codex',
    name: 'Codex',
    usageName: 'Codex',
    icon: 'codex',
    skillPrefix: '$',
    defaultMode: 'on-request',
  },
} as const

export type Harness = keyof typeof PROVIDERS
export type ProviderId = (typeof PROVIDERS)[Harness]['provider']

export const HARNESSES = Object.keys(PROVIDERS) as Harness[]
export const DEFAULT_HARNESS: Harness = 'claude'
export const DEFAULT_PROVIDER = PROVIDERS[DEFAULT_HARNESS].provider

export const knownHarness = ({ name }: { name?: unknown }): Harness | undefined =>
  HARNESSES.find(harness => harness === name)

export const knownProvider = ({ name }: { name?: string }): ProviderId | undefined =>
  HARNESSES.map(harness => PROVIDERS[harness].provider).find(provider => provider === name)

// Any provider id other than codex, or none, is Claude: hooks and older records name it more than one way.
export const harnessOf = ({ provider }: { provider?: string }): Harness =>
  provider === 'codex' ? 'codex' : 'claude'

export const providerIdOf = ({ harness }: { harness: Harness }): ProviderId =>
  PROVIDERS[harness].provider

// A card send waiting for its turn names the agent it will reach; the server receipt and the page share it.
export function queuedAgentLabel({ agent }: {
  agent: {
    harness: string
    model?: string
    effort?: string
  }
}) {
  const model = agent.model ? ` / ${agent.model}` : ''
  const effort = agent.effort ? ` · ${agent.effort}` : ''

  return `Queued · ${agent.harness}${model}${effort}`
}

export const providerLabel = ({ provider }: { provider?: string }) =>
  PROVIDERS[harnessOf({ provider })].name

export const skillPrefix = ({ provider }: { provider?: string }) =>
  PROVIDERS[harnessOf({ provider })].skillPrefix
