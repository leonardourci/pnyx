// Reducers write plain JSON trees. Copy a branch only when its value changes, retaining all untouched branches.
export function draft<T extends object>({
  state,
  change,
}: {
  state: T
  change({ state }: { state: T }): void
}): T {
  interface Branch {
    value: object
    copy?: object
    parent?: Branch
    proxy: object
  }
  const inserted = new WeakSet<object>()
  const branches = new WeakMap<object, Branch>()
  const proxies = new WeakMap<object, Branch>()

  const writable = ({ branch }: { branch: Branch }): object => {
    if (!branch.copy) {
      branch.copy = Array.isArray(branch.value) ? branch.value.slice() : { ...branch.value }

      if (branch.parent) {
        writable({ branch: branch.parent })
      }
    }

    return branch.copy
  }

  const wrap = ({
    value,
    parent,
  }: {
    value: object
    parent?: Branch
  }): object => {
    if (inserted.has(value)) {
      return value
    }

    const known = branches.get(value) ?? proxies.get(value)

    if (known) {
      return known.proxy
    }

    const branch: Branch = {
      value,
      parent,
      proxy: value,
    }
    const current = () => branch.copy ?? value
    branch.proxy = new Proxy(
      value,
      {
      // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns these signatures.
        get(
          _target,
          key,
        ) {
          const child = Reflect.get(
            current(),
            key,
          )

          return child && typeof child === 'object' ? wrap({
            value: child,
            parent: branch,
          }) : child
        },
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns these signatures.
        set(
          _target,
          key,
          next,
        ) {
          if (Reflect.has(
            current(),
            key,
          ) && Reflect.get(
            current(),
            key,
          ) === next) {
            return true
          }

          if (next && typeof next === 'object' && !branches.has(next) && !proxies.has(next)) {
            inserted.add(next)
          }

          return Reflect.set(
            writable({ branch }),
            key,
            next,
          )
        },
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns these signatures.
        deleteProperty(
          _target,
          key,
        ) {
          return !Reflect.has(
            current(),
            key,
          ) || Reflect.deleteProperty(
            writable({ branch }),
            key,
          )
        },
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns these signatures.
        has(
          _target,
          key,
        ) {
          return Reflect.has(
            current(),
            key,
          )
        },
        ownKeys() {
          return Reflect.ownKeys(current())
        },
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns these signatures.
        getOwnPropertyDescriptor(
          _target,
          key,
        ) {
          return Reflect.getOwnPropertyDescriptor(
            current(),
            key,
          )
        },
      },
    )
    branches.set(
      value,
      branch,
    )
    proxies.set(
      branch.proxy,
      branch,
    )

    return branch.proxy
  }

  const finish = ({ value }: { value: unknown }): unknown => {
    if (!value || typeof value !== 'object') {
      return value
    }

    const branch = proxies.get(value) ?? branches.get(value)

    if (branch && !branch.copy) {
      return branch.value
    }

    const result = branch?.copy ?? value

    for (const key of Object.keys(result)) {
      Reflect.set(
        result,
        key,
        finish({
          value: Reflect.get(
            result,
            key,
          ),
        }),
      )
    }

    return result
  }

  const proxy = wrap({ value: state }) as T
  change({ state: proxy })

  return finish({ value: proxy }) as T
}
