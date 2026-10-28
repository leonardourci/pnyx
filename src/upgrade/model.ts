import type { EventBase } from '#store/events.ts'
import type { Suggestion } from '#hydra/transcripts-catalog.ts'

export const UPGRADE_COMMAND = '/upgrade'

export const UPGRADE_SUGGESTION: Suggestion = {
  command: UPGRADE_COMMAND,
  description: 'Upgrade Pnyx and restart its server. Workers keep going; any the restart pauses pick up again on their own.',
  source: 'Built-in',
  kind: 'command',
}

export const isUpgradeSuggestion = ({ item }: { item?: Suggestion }): boolean =>
  item?.kind === 'command' && item.command === UPGRADE_COMMAND

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
  state: 'running' | 'done' | 'failed' | 'stopped'
  seconds: number
}

// A Hydra message sent while the upgrade ran; it reaches Hydra once the upgrade ends.
export interface HeldMessage {
  id: string
  text: string
  actor: string
  at: string
}

// One /upgrade the owner sent to Hydra, from its place in the queue to the restarted server.
export interface UpgradeOperation {
  // The Hydra message that asked for it.
  id: string
  state: 'queued' | 'running' | 'restarting' | 'done' | 'current' | 'failed' | 'refused' | 'stopped'
  // The Pnyx folder, with the home folder shortened to ~.
  folder: string
  queuedAt: string
  startedAt?: string
  endedAt?: string
  steps: UpgradeStep[]
  from?: string
  to?: string
  // The step that failed or was stopped, and the last lines of its output.
  failed?: UpgradeStepName
  error?: string
  // Whether a failed or stopped upgrade put the folder back on from; false leaves it partly upgraded.
  rolledBack?: boolean
  // Why a refused upgrade did not start.
  reasons?: string[]
  held?: HeldMessage[]
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
