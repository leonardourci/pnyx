// The one Pnyx every flow shares: the flows lane loads this module once, so its server starts once.
// Each flow takes its own Hydra with `pnyx.scenario()`; a restart or recovery flow may call `pnyx.restart()`.
import { scenarioGroup } from './harness.ts'

// Retries wait longer than the run, so only the owner's messages try to start a Hydra that is down.
export const pnyx = scenarioGroup({ retryDelays: [600_000] })
export type Scenario = Awaited<ReturnType<typeof pnyx.scenario>>
