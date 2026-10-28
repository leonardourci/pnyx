import type { Landing, Merger } from '../tasks/delivery/model.ts'

export interface HydraProject {
  path: string
  name: string
  detached: boolean
  landing?: Landing
  merge?: Merger
  startCommand?: {
    name: string
    command: string
    bringsOwnFolder: boolean
  }
  // A shell command run in the project folder that makes a task's copy and prints its path.
  copy?: string
}

export interface TaskCopy {
  path: string
  project: string
  via: 'worktree' | 'command'
  branch?: string
  base?: string
  state: 'active' | 'flagged' | 'removed'
  reason?: string
}
