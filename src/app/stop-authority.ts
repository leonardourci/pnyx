import { inform } from '#app/command-notices.ts'
import type { Meta } from './command-meta.ts'
import { workerIdentity } from '#workers/worker-identity.ts'

export function requireStopAuthority({ meta }: { meta: Meta }): void {
  if (workerIdentity({ actor: meta.actor })) {
    inform({
      reason: 'Agent requested a stop or immediate delivery',
      clear: 'pnyx-axi reply <task> --text "<message>"',
    })
  }
}
