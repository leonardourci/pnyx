import fs from 'node:fs'
import { basename } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { onTestFinished } from 'vitest'

export function quietNativeWatch({ root }: { root: string }) {
  const nativeWatch = fs.watch
  const notifications = new Map<string, () => void>()
  onTestFinished(() => {
    fs.watch = nativeWatch
    syncBuiltinESMExports()
  })
  fs.watch = ((...args: unknown[]) => {
    const path = String(args[0])
    const callback = args.at(-1)
    const withinRoot = path === root || path.startsWith(`${root}/`)

    if (withinRoot && typeof callback === 'function') {
      args[args.length - 1] = () => {}
    }

    const watcher = Reflect.apply(
      nativeWatch,
      fs,
      args,
    )

    if (withinRoot && typeof callback === 'function') {
      notifications.set(
        path,
        () => Reflect.apply(
          callback,
          watcher,
          [
            'change',
            basename(path),
          ],
        ),
      )
    }

    return watcher
  }) as typeof fs.watch
  syncBuiltinESMExports()

  return {
    change({ path }: { path: string }) {
      const notify = notifications.get(path)

      if (!notify) {
        throw new Error(`No native watcher installed for ${path}`)
      }

      notify()
    },
  }
}
