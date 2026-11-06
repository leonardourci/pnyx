// Each harness Pnyx runs: its provider id in agent records, the name people see, how its skills are invoked
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

export const isHarness = ({ harness }: { harness?: string }): boolean =>
  HARNESSES.includes(harness as Harness)

export const isProviderId = ({ provider }: { provider: string }): boolean =>
  HARNESSES.some(harness => PROVIDERS[harness].provider === provider)

// Any provider id other than codex, or none, is Claude: hooks and older records name it more than one way.
export const harnessOf = ({ provider }: { provider?: string }): Harness =>
  provider === 'codex' ? 'codex' : 'claude'

export const providerIdOf = ({ harness }: { harness: Harness }): ProviderId =>
  PROVIDERS[harness].provider

export const providerLabel = ({ provider }: { provider?: string }) =>
  PROVIDERS[harnessOf({ provider })].name

export const skillPrefix = ({ provider }: { provider?: string }) =>
  PROVIDERS[harnessOf({ provider })].skillPrefix
