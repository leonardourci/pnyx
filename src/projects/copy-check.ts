import { COPY_TIMEOUT_MS, commonDir, git, onBranch } from './git.ts'
import type { TaskCopy } from './model.ts'
import { landedWork } from '#tasks/delivery/proof.ts'
import type { Card } from '#tasks/model.ts'
import { runProcess } from '#app/run-process.ts'
import { isFolder } from '#workers/folders.ts'

export type CopyCheck = {
  gone?: boolean
  clean: true
  landed: true
}
  | {
    gone?: undefined
    clean: boolean
    landed: boolean
    reason: string
  }

export async function checkCopy({
  card,
  copy,
}: {
  card: Card
  copy: TaskCopy
}): Promise<CopyCheck> {
  if (!isFolder({ path: copy.path })) {
    return {
      gone: true,
      clean: true,
      landed: true,
    }
  }

  const status = await git({
    cwd: copy.path,
    args: [
      'status',
      '--porcelain',
    ],
  })
  const head = await git({
    cwd: copy.path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })

  if (!status.ok || !head.ok) {
    return {
      clean: false,
      landed: false,
      reason: 'it is not a git checkout Pnyx can read',
    }
  }

  const {
    landed,
    refs,
    reason,
  } = await landedWork({
    card,
    copy,
    head: head.out,
  })
  const currentHead = await git({
    cwd: copy.path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  const currentStatus = await git({
    cwd: copy.path,
    args: [
      'status',
      '--porcelain',
    ],
  })

  const changed = currentHead.out !== head.out || currentStatus.out !== status.out

  if (!currentHead.ok || !currentStatus.ok || changed) {
    return {
      clean: false,
      landed: false,
      reason: 'its work changed during the landing check; its copy was kept',
    }
  }

  const clean = status.out === ''

  if (clean && landed) {
    return {
      clean,
      landed,
    }
  }

  return {
    clean,
    landed,
    reason: !clean ? 'it has uncommitted changes'
      : reason ?? `its work has not landed on ${refs.join(' or ') || 'the default branch'}`,
  }
}

export async function removeCopy({
  copy,
  force,
}: {
  copy: TaskCopy
  force: boolean
}): Promise<string | undefined> {
  const common = await commonDir({ cwd: copy.path })
  const gitDir = await git({
    cwd: copy.path,
    args: [
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    ],
  })

  if (!common || !gitDir.ok || gitDir.out === common) {
    return 'it is not a git worktree Pnyx can remove'
  }

  if (!force && !await onBranch({ cwd: copy.path })) {
    return 'its commit is on no branch'
  }

  const run = await runProcess({
    command: 'git',
    args: [
      `--git-dir=${common}`,
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      copy.path,
    ],
    timeout: COPY_TIMEOUT_MS,
  })

  return run.status === 0 ? undefined : `git could not remove it: ${run.stderr.trim().slice(-300)}`
}
