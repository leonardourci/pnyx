export interface ReportCall {
  task: string
  ask: string
}

// The text stays in the log, on the task.report event this names.
export interface TaskReport {
  id: string
  at: string
  actor: string
  chars: number
  review?: {
    id: string
    at: string
    actor: string
    calls: ReportCall[]
  }
}
