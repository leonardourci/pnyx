import { existsSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [
  , , , folder,
  command,
] = process.argv

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
  await new Promise(resolve => {
    const watcher = watch(
      folder,
      () => {
        if (existsSync(join(
          folder,
          'release',
        ))) {
          watcher.close()
          resolve()
        }
      },
    )

    if (existsSync(join(
      folder,
      'release',
    ))) {
      watcher.close()
      resolve()
    }
  })
}
