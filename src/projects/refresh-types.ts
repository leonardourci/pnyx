export interface ProjectRefresh {
  url: string
  merge: string
  path: string
  repository?: string
  state: 'current' | 'advanced' | 'skipped' | 'needs-attention' | 'unknown'
  reason?: string
  branch?: string
  remote?: string
  defaultBranch?: string
  before?: string
  target?: string
  after?: string
}
