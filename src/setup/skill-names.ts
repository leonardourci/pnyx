export const ORCHESTRATE_SKILL = 'othrys-orchestrate'
const ARRANGE_COLUMNS_SKILL = 'othrys-arrange-columns'
export const MANAGE_WORKERS_SKILL = 'othrys-manage-workers'
export const SET_UP_SKILL = 'othrys-set-up'
export const INSCRIBE_SKILL = 'inscribe'
export const REPORT_PROGRESS_SKILL = 'othrys-report-progress'
export const CLI_SKILL = 'othrys-cli'

export const TITAN_SKILLS = [
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
