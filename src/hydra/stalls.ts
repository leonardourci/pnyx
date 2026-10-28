import type { WakeReason } from './wake-reasons.ts'

// A stall, ended wait or unconfirmed reply the stall check found, as one reason line.
export type StallItem = WakeReason & {
  id: string
  card: string
}
