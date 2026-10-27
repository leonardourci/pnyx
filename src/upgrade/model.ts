import type { EventBase } from '../core/model.ts'
import type { Suggestion } from '../thread/catalog.ts'

export const UPGRADE_COMMAND = '/upgrade'

// The Pnyx group of the Hydra chat's slash menu.
export const UPGRADE_SUGGESTION: Suggestion = {
  command: UPGRADE_COMMAND,
  description: 'Upgrade Pnyx and restart its server. Workers keep going; any the restart pauses pick up again on their own.',
  source: 'Pnyx',
  kind: 'command',
}

export const upgradeCommand = ({ text }: { text: string }) => text.trim() === UPGRADE_COMMAND

export type UpgradeStepName = 'pull' | 'install' | 'build' | 'restart'

// Each step's name before, while and after it runs.
export const STEP_WORDS: Record<UpgradeStepName, [string, string, string]> = {
  pull: [
    'Pull',
    'Pulling',
    'Pulled',
  ],
  install: [
    'Install',
    'Installing',
    'Installed',
  ],
  build: [
    'Build',
    'Building',
    'Built',
  ],
  restart: [
    'Restart',
    'Restarting',
    'Restarted',
  ],
}

export interface UpgradeStep {
  step: UpgradeStepName
  state: 'running' | 'done' | 'failed'
  seconds: number
}

// One /upgrade the owner sent to Hydra, from its place in the queue to the restarted server.
export interface UpgradeOperation {
  // The Hydra message that asked for it.
  id: string
  state: 'queued' | 'running' | 'restarting' | 'done' | 'current' | 'failed' | 'refused'
  // The Pnyx folder, with the home folder shortened to ~.
  folder: string
  queuedAt: string
  startedAt?: string
  endedAt?: string
  steps: UpgradeStep[]
  from?: string
  to?: string
  // The step that failed, and the last lines of its output.
  failed?: UpgradeStepName
  error?: string
  // Why a refused upgrade did not start.
  reasons?: string[]
}

export type UpgradeEvent = EventBase & {
  type: 'pnyx.upgrade'
  data: UpgradeOperation
}

// What the daily check found: whether GitHub's main has a commit the installed Pnyx lacks.
export interface UpgradeStatus {
  available: boolean
  checkedAt: string
}
