import type { EventBase } from '#store/events.ts'
import type { Suggestion } from '#hydra/transcripts-catalog.ts'

export const UPGRADE_COMMAND = '/upgrade'
export const RESTART_COMMAND = '/restart'

export const RESTART_SUGGESTION: Suggestion = {
  command: RESTART_COMMAND,
  description: 'Restart Pnyx on its current code. Turns it cuts resume from their saved sessions.',
  source: 'Built-in',
  kind: 'command',
}

export const restartCommand = ({ text }: { text: string }) => text.trim() === RESTART_COMMAND

export const isServerCommand = ({ item }: { item?: Suggestion }): boolean =>
  item?.kind === 'command' && [
    UPGRADE_COMMAND,
    RESTART_COMMAND,
  ].includes(item.command)

export const UPGRADE_SUGGESTION: Suggestion = {
  command: UPGRADE_COMMAND,
  description: 'Upgrade Pnyx and restart its server. Workers keep going; any the restart pauses pick up again on their own.',
  source: 'Built-in',
  kind: 'command',
}

export const isUpgradeSuggestion = ({ item }: { item?: Suggestion }): boolean =>
  item?.kind === 'command' && item.command === UPGRADE_COMMAND

export const upgradeCommand = ({ text }: { text: string }) => text.trim() === UPGRADE_COMMAND

export type UpgradeStepName = 'pull' | 'install' | 'build' | 'data' | 'restart'

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
  data: [
    'Check data',
    'Checking data',
    'Checked data',
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

// One /upgrade the owner sent to Hydra, from its place in the queue to the restarted server.
export interface UpgradeOperation {
  // The Hydra message that asked for it.
  id: string
  // waiting: built, and restarting once no agent is mid-turn, on Restart now, or at restartBy.
  state: 'queued' | 'running' | 'waiting' | 'restarting' | 'done' | 'current' | 'failed' | 'refused' | 'stopped'
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
  // When a built upgrade restarts even if an agent is still mid-turn.
  restartBy?: string
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

// How much of a commit the chat and the CLI show, as `pnyx-axi --version` does.
export const COMMIT_LENGTH = 7

// The chat's milestone line for an upgrade, by how far it got, and the icon each draws.
const MILESTONES = {
  started: {
    text: 'Upgrade started',
    icon: 'upgrade',
  },
  done: {
    text: 'Upgraded',
    icon: 'check',
  },
  current: {
    text: 'Already up to date',
    icon: 'check',
  },
  failed: {
    text: 'Upgrade failed',
    icon: 'error',
  },
  refused: {
    text: 'Upgrade not started',
    icon: 'error',
  },
  stopped: {
    text: 'Upgrade stopped',
    icon: 'stop',
  },
} as const

// One line per upgrade, reworded as it goes; a queued upgrade and a /restart have none.
export function upgradeMilestone({ operation }: { operation: UpgradeOperation }) {
  if (operation.state === 'queued' || operation.steps[0]?.step === 'restart') {
    return undefined
  }

  if (operation.state === 'done' && operation.to) {
    return `${MILESTONES.done.text} to ${operation.to.slice(
      0,
      COMMIT_LENGTH,
    )}`
  }

  return operation.state === 'running' || operation.state === 'waiting' || operation.state === 'restarting'
    ? MILESTONES.started.text
    : MILESTONES[operation.state].text
}

export const upgradeMilestoneIcon = ({ text }: { text: string }) => Object.values(MILESTONES)
  .find(milestone => text === milestone.text || text.startsWith(`${milestone.text} to `))?.icon
