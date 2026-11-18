import { existsSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [
  , , , folder,
  command,
] = process.argv

const GATE_TIMEOUT_MS = 15_000

if (command === 'display-message') {
  process.stdout.write('/dev/ttys123\n')
} else if (command === 'load-buffer') {
  process.stdin.resume()
  await new Promise(resolve => process.stdin.once(
    'end',
    resolve,
  ))
  writeFileSync(
    join(
      folder,
      'received',
    ),
    '',
  )
  await new Promise((resolve, reject) => {
    const release = join(folder, 'release')
    const watcher = watch(folder, checkRelease)
    const timeout = setTimeout(() => {
      watcher.close()
      reject(new Error('The test did not release the terminal delivery gate'))
    }, GATE_TIMEOUT_MS)

    function checkRelease() {
      if (!existsSync(release)) {
        return
      }

      clearTimeout(timeout)
      watcher.close()
      resolve()
    }

    checkRelease()
  })
}
