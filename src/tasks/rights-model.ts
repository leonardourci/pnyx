import type { EventBase } from '#store/events.ts'

export type RightsLevel = 'read-only' | 'local-build' | 'ship'
export type OutwardRight = {
  operation: 'github.comment.create'
  repository: string
  subject: number
} | {
  operation: 'slack.message.create'
  workspace: string
  channel: string
}
export type RightsScope = {
  level: RightsLevel
  repository: string
  branch: string
  baseRepository: string
  baseBranch: string
  channels: OutwardRight[]
}
export type PolicyIdentity = {
  grant: string
  revision: number
  digest: string
}
export type { NativePolicyReceipt } from '#workers/native-policy.ts'
import type { NativePolicyReceipt } from '#workers/native-policy.ts'

export type TaskRights = {
  revision: number
  requested: {
    id: string
    scope: RightsScope
    reason: string
  }
  granted?: {
    id: string
    request: string
    scope: RightsScope
    at: string
  }
  revoked?: {
    at: string
    reason: string
  }
  effective?: NativePolicyReceipt
}
export type RightsChange = {
  type: 'task.rights-requested'
  data: {
    request: string
    revision: number
    scope: RightsScope
    reason: string
  }
} | {
  type: 'task.rights-granted'
  data: {
    request: string
    revision: number
    grant: string
    scope: RightsScope
  }
} | {
  type: 'task.rights-revoked'
  data: {
    grant: string
    revision: number
    reason: string
  }
} | {
  type: 'task.native-policy'
  data: NativePolicyReceipt
}
export type RightsEvent = EventBase & RightsChange
