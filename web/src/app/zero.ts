import { Zero } from '@rocicorp/zero'
import { schema } from '#store/zero-schema.ts'

// One Zero client per installation; it holds every Hydra the page opens.
export function createPageZero({
  installation,
  token,
}: {
  installation: string
  token: string
}) {
  return new Zero({
    schema,
    cacheURL: `${location.origin}/zero`,
    auth: token,
    userID: installation,
  })
}

declare module '@rocicorp/zero' {
  interface DefaultTypes {
    schema: typeof schema
  }
}
