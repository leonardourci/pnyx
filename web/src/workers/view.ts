import { PROVIDERS } from '#workers/providers.ts'

export const harnessName = ({ provider }: { provider: string }) =>
  Object.values(PROVIDERS).find(entry => entry.provider === provider)?.name ?? provider
