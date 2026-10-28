export interface FirstmateRecord {
  home: string
  task: string
  backlog?: Record<string, unknown>
  meta: Record<string, string>
  status: string
  present?: {
    meta: boolean
    status: boolean
  }
}
