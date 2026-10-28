import type { EventBase } from '#store/events.ts'
import type { SteeringClaim } from '#workers/model.ts'

export interface SourceCommand {
  executable: string
  digest: string
  argv: string[]
  cwd: string
}

export interface SourceRun {
  id: string
  server: string
  at: string
}

export type SourceOutcome = 'completed' | 'failed' | 'interrupted' | 'stopped'
  | 'expired' | 'overflow' | 'stale'

export interface SourceResult {
  sequence: number
  run: string
  at: string
  outcome: SourceOutcome
  stdout: string
  stderr: string
  detail: string
  terminal: boolean
  message: string
  alerted?: string
  handled?: {
    at: string
    actor: string
    claim: SteeringClaim
  }
}

export interface ExternalSource {
  id: string
  registration: string
  owner: SteeringClaim
  command: SourceCommand
  timeoutMs: number
  maxBytes: number
  expiresAt: string
  restart: 'never' | 'on-failure'
  maxRuns: number
  runs: number
  state: 'registered' | 'running' | 'ended' | 'retired'
  run?: SourceRun
  results: SourceResult[]
  lavish?: {
    page: string
    after?: {
      source: string
      sequence: number
    }
    reply?: {
      id: string
      text: string
      accepted?: {
        at: string
        receipt: string
      }
    }
  }
}

export type ExternalSourceChange =
  | {
    type: 'task.source.lavish.published'
    data: {
      source: string
      reply: string
      accepted: {
        at: string
        receipt: string
      }
    }
  }
  | {
    type: 'task.source.registered'
    data: { source: ExternalSource }
  }
  | {
    type: 'task.source.started'
    data: {
      source: string
      run: SourceRun
    }
  }
  | {
    type: 'task.source.result'
    data: {
      source: string
      result: SourceResult
    }
  }
  | {
    type: 'task.source.alerted'
    data: {
      source: string
      sequence: number
      detail: string
    }
  }
  | {
    type: 'task.source.handled'
    data: {
      source: string
      sequence: number
      handled: NonNullable<SourceResult['handled']>
    }
  }

export type ExternalSourceEvent = EventBase & ExternalSourceChange
