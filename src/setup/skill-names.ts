export const ORCHESTRATE_SKILL = 'pnyx-orchestrate'
const ARRANGE_COLUMNS_SKILL = 'pnyx-arrange-columns'
export const MANAGE_WORKERS_SKILL = 'pnyx-manage-workers'
export const SET_UP_SKILL = 'pnyx-set-up'
export const INSCRIBE_SKILL = 'inscribe'
export const REPORT_PROGRESS_SKILL = 'pnyx-report-progress'
export const CLI_SKILL = 'pnyx-cli'

export const HYDRA_SKILLS = [
  ORCHESTRATE_SKILL,
  MANAGE_WORKERS_SKILL,
  ARRANGE_COLUMNS_SKILL,
  INSCRIBE_SKILL,
  SET_UP_SKILL,
] as const
export const GLOBAL_SKILLS = [
  REPORT_PROGRESS_SKILL,
  CLI_SKILL,
] as const
