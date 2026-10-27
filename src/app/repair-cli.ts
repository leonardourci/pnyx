import { repairHydra } from './repair.ts'
import { guard, parse, COMMON } from './cli-support.ts'

export const repair = guard({
  handler: ({ args }) => {
    const { hydraId } = parse({
      args,
      options: COMMON,
      positionals: 0,
    })
    const result = repairHydra({ hydraId })

    return {
      repair: result.tornBytes > 0 ? `set aside ${result.tornBytes} torn bytes` : 'none: log ends cleanly',
      ...(result.preserved ? { preserved: result.preserved } : {}),
      snapshot: `rebuilt through seq ${result.seq}`,
    }
  },
})
