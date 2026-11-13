import { Zero } from '@rocicorp/zero'
import { schema } from '#store/zero-schema.ts'
import { ZERO_OWNER, ZERO_PATH } from '#app/server-protocol.ts'

// zero-cache is on the page's own origin behind the token cookie; each installation keeps its own cached rows.
export function createPageZero({ installation }: { installation: string }) {
  return new Zero({
    schema,
    cacheURL: `${location.origin}${ZERO_PATH}`,
    userID: ZERO_OWNER,
    storageKey: installation,
  })
}
