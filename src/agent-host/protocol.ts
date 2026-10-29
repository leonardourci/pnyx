import type { HostedEvent, HostedFact, HostedInput, HostedSession, HostedUsage, NativePermission, PermissionDecision, ModelOption } from '#workers/provider.ts'
import type { NativeGroup } from './groups.ts'
import { HydraError } from '#store/errors.ts'

export const PROTOCOL = 1
export const CAPABILITIES = [
  'controllers',
  'named-requests',
  'critical-outbox',
  'live-owners',
  'volatile-inputs',
  'quiescent-maintenance',]
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
export const MAX_SOCKET_BYTES = 2 * MAX_FRAME_BYTES
export type ProviderId = 'claude-code' | 'codex'
export type SessionRef = {
  id: string
  epoch: string
}
export type Scope = { kind: 'host' } | {
  kind: 'session'
  ref: SessionRef
}
export type Grant = {
  scope: Scope
  generation: string
  revision: number
}
export type Summary = {
  boot?: string
  lastAliveAt?: number
  recovery?: 'boot_changed' | 'group_ended' | 'host_lost'
  groups?: NativeGroup[]
  ref: SessionRef
  provider: ProviderId
  nativeId?: string
  path?: string
  phase: 'opening' | 'live' | 'closed' | 'failed' | 'recovery_required'
  controllerRevision: number
}
export type OpenOptions = {
  provider: ProviderId
  cwd: string
  settings: Record<string, string>
  environment: Record<string, string>
  resume?: {
    nativeId: string
    path?: string
  }
  instructions?: string
  context?: string
  outputSchema?: Record<string, unknown>
  allow?: string[]
}
export type Mutation = {
  ref: SessionRef
  controller: string
} & (
  {
    kind: 'input'
    input: HostedInput
  }
  | {
    kind: 'answer'
    answerId: string
    permission: string
    decision: PermissionDecision
  }
  | {
    kind: 'interrupt'
    expectedTurn: string
  }
  | {
    kind: 'set'
    setting: string
    value: string
  }
  | {
    kind: 'context'
    text: string
  }
  | {
    kind: 'close'
    expectedIdle: boolean
  }
)
export type Maintenance = {
  mode: 'ready' | 'draining' | 'stopped'
  drain?: string
  blockers: {
    ref?: SessionRef
    reasons: string[]
  }[]
}
export type Operation = Mutation
  | { kind: 'status' }
  | {
    kind: 'drain'
    controller: string
  }
  | {
    kind: 'shutdown'
    controller: string
    drain: string
    when: 'quiescent'
  }
  | {
    kind: 'attach'
    scope: Scope
    expectedRevision: number
  }
  | {
    kind: 'open'
    controller: string
    options: OpenOptions
  }
  | {
    kind: 'catalog'
    provider: ProviderId
    cwd: string
    environment: Record<string, string>
  }
  | {
    kind: 'commands'
    ref: SessionRef
  }
export type AnswerReceipt = {
  answerId: string
  permission: string
  phase: 'received' | 'submitted' | 'aborted' | 'failed' | 'unknown'
}
export type Result = {
  kind: 'maintenance'
  status: Maintenance
}
  | { kind: 'shutdown' }
  | {
    kind: 'attached'
    control: Grant
  }
  | {
    kind: 'opened'
    session: Summary
  }
  | {
    kind: 'input'
    inputId: string
    phase: 'queued'
  }
  | {
    kind: 'answer'
    receipt: AnswerReceipt
  }
  | {
    kind: 'ok'
    session?: Summary
  }
  | {
    kind: 'catalog'
    models: ModelOption[]
  }
  | {
    kind: 'commands'
    commands: Awaited<ReturnType<NonNullable<HostedSession['commands']>>>
  }
  | {
    kind: 'error'
    code: string
    message: string
  }
export type Critical = HostedFact | Extract<HostedEvent, { type: 'structured' | 'compaction' }>
export type Fact = {
  ref: SessionRef
  seq: number
  at: string
  event: Critical
}
export type EventFrame = {
  type: 'event'
  ref: SessionRef
  seq: number
  at: string
  event: HostedEvent
}
export type Snapshot = {
  session: Summary
  admittedInputIds: string[]
  native?: Omit<ReturnType<HostedSession['snapshot']>, 'answers' | 'outcome'> & { answers: AnswerReceipt[] }
  text: {
    id: string
    text: string
  }[]
  tools: string[]
  thinking: string[]
  activity?: 'working' | 'finished' | 'carried'
  usage?: Omit<HostedUsage, 'type'>
  retention: 'healthy' | 'degraded' | 'exhausted'
}
export type ToHost = {
  type: 'hello'
  protocol: number
  installation: string
  token: string
  capabilities?: string[]
}
  | {
    type: 'call'
    id: string
    operation: Operation
  }
  | {
    type: 'result'
    id: string
    requestId: string
  }
  | {
    type: 'watch'
    ref: SessionRef
    after?: number
  }
  | {
    type: 'ack'
    id: string
    ref: SessionRef
    controller: string
    appliedFactsThrough: number
  }
export type ToClient = {
  type: 'ready'
  protocol: number
  instance: string
  build: string
  capabilities: string[]
  hostControllerRevision: number
  maintenance: Maintenance
  predecessor?: string
  sessions: Summary[]
  ledger: 'intact' | 'recovery_required'
}
  | {
    type: 'reply'
    id: string
    result: Result
  }
  | {
    type: 'snapshot'
    ref: SessionRef
    viewThrough: number
    pendingFacts: Fact[]
    snapshot: Snapshot
  }
  | EventFrame
  | {
    type: 'resync'
    ref: SessionRef
    reason: 'cursor_expired'
  }
  | {
    type: 'error'
    code: string
    message: string
  }

export function fail({
  code,
  message,
}: {
  code: string
  message: string
}): never {
  throw new HydraError({
    code,
    message,
  })
}

export const errorResult = ({ error }: { error: unknown }): Extract<Result, { kind: 'error' }> => {
  if (error instanceof HydraError) {
    return {
      kind: 'error',
      code: error.code,
      message: error.message,
    }
  }

  // Native errors can include answer values; expose only the failure class at the transport boundary.
  return {
    kind: 'error',
    code: 'NATIVE_ERROR',
    message: 'The native operation failed',
  }
}

export type PendingPermission = {
  request: NativePermission
  decide({ decision }: { decision: PermissionDecision }): void
}
