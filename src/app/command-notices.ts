import { AsyncLocalStorage } from 'node:async_hooks'

export interface CommandNotice {
  task?: string
  reason: string
  clear: string
}

type NoticeScope = {
  active: boolean
  notices: CommandNotice[]
}

let current: AsyncLocalStorage<NoticeScope> | undefined

function sameNotice({
  left,
  right,
}: {
  left: CommandNotice
  right: CommandNotice
}): boolean {
  return left.task === right.task && left.reason === right.reason && left.clear === right.clear
}

export function inform({
  task,
  reason,
  clear,
}: CommandNotice): void {
  const notice: CommandNotice = {
    reason,
    clear,
  }

  if (task !== undefined) {
    notice.task = task
  }

  const scope = current?.getStore()

  const duplicate = scope?.notices.some(saved => sameNotice({
    left: saved,
    right: notice,
  }))

  if (scope?.active && !duplicate) {
    scope.notices.push(notice)
  }
}

export function collectingNotices(): boolean {
  return current?.getStore()?.active === true
}

export function commandNotices({ task }: { task?: string } = {}): CommandNotice[] {
  const scope = current?.getStore()

  if (!scope?.active) {
    return []
  }

  return scope.notices.filter(notice => task === undefined
    || notice.task === undefined || notice.task === task)
}

export function withCommandNotices<T>({ run }: { run(): T }): T {
  if (current?.getStore()?.active) {
    return run()
  }

  if (!current) {
    current = new AsyncLocalStorage<NoticeScope>()
  }

  const scope = {
    active: true,
    notices: [] as CommandNotice[],
  }

  const finish = ({ result }: { result: T }): T => {
    scope.active = false

    if (scope.notices.length && result !== null && typeof result === 'object') {
      const prior = (result as { notices?: CommandNotice[] }).notices
      const notices: CommandNotice[] = []

      for (const notice of [
        ...(Array.isArray(prior) ? prior : []),
        ...scope.notices,
      ]) {
        if (!notices.some(saved => sameNotice({
          left: saved,
          right: notice,
        }))) {
          notices.push(notice)
        }
      }

      return {
        ...result,
        notices,
      }
    }

    return result
  }

  return current.run(
    scope,
    () => {
      try {
        const result = run()

        if (result instanceof Promise) {
          return result.then(result => finish({ result })).finally(() => {
            scope.active = false
          }) as T
        }

        return finish({ result })
      } catch (error) {
        scope.active = false
        throw error
      }
    },
  )
}
