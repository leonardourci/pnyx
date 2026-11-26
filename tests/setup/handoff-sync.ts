import filesystem from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { git } from './upgrade.ts'

export function afterHandoffSync({
  home,
  titan,
  source,
  target,
  cwd,
  branch,
  after,
  cut = 'both',
}: {
  home: string
  titan: string
  source: string
  target: string
  cwd: string
  branch: string
  cut?: 'first' | 'both'
  after({ first }: { first: 'source' | 'target' }): void
}): () => void {
  const logs = [
    source,
    target,
  ].map(task => join(
    home,
    'titans',
    titan,
    'tasks',
    task,
    'task.log',
  ))
  const inodes = logs.map(path => filesystem.statSync(path).ino)
  const synced = new Set<number>()
  const original = filesystem.fdatasyncSync
  let fired = false
  let first: 'source' | 'target' | undefined

  // eslint-disable-next-line othrys/object-params -- Node owns the sync signature.
  filesystem.fdatasyncSync = fd => {
    original(fd)
    const inode = filesystem.fstatSync(fd).ino

    if (fired || !inodes.includes(inode) || git({
      cwd,
      args: [
        'branch',
        '--show-current',
      ],
    }) !== branch) {
      return
    }

    const assignments = logs.map(path => filesystem.readFileSync(
      path,
      'utf8',
    ).trim()
      .split('\n')
      .flatMap(line => {
        const record = JSON.parse(line) as {
          id: string
          event?: {
            type: string
            cardId: string
            data: { handoff?: { copy?: { branch: string } } }
          }
        }

        return record.event?.type === 'task.session' && record.event.cardId === target
        && record.event.data.handoff?.copy?.branch === branch ? [record.id] : []
      }))

    const current = inodes.indexOf(inode)

    if (assignments[current]!.length) {
      synced.add(inode)

      if (first === undefined) {
        first = current === 0 ? 'source' : 'target'
      }
    }

    const sameDecision = assignments[0]!.some(id => assignments[1]!.includes(id))
    const complete = synced.size === inodes.length && sameDecision

    if (first && (cut === 'first' || complete)) {
      fired = true
      after({ first })
    }
  }

  syncBuiltinESMExports()

  return () => {
    filesystem.fdatasyncSync = original
    syncBuiltinESMExports()
  }
}
