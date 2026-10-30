// Hydra state contains plain JSON values; tracked views preserve that shape.
const originals = new WeakMap<object, object>()

export type PreimageObserver = ({
  target,
  key,
}: {
  target: object
  key: string | symbol
}) => void

export function cloneValue<T>({ value }: { value: T }): T {
  const original = value !== null && typeof value === 'object' ? originals.get(value) : undefined

  if (original) {
    return structuredClone(original) as T
  }

  if (Array.isArray(value)) {
    return value.map(child => cloneValue({ value: child })) as T
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([
      key,
      child,
    ]) => [
      key,
      cloneValue({ value: child }),
    ])) as T
  }

  return value
}

// The writer owns its loaded state; derivations retain only properties changed by this event.
export function preimage<T extends object>({
  state,
  change,
  observers,
}: {
  state: T
  change({ state }: { state: T }): void
  observers: Set<PreimageObserver>
}): {
  before: T
  release(): void
} {
  const changed = new WeakMap<object, Map<string | symbol, PropertyDescriptor | undefined>>()
  const readers = new WeakMap<object, object>()
  const writers = new WeakMap<object, object>()

  const remember = ({
    target,
    key,
  }: {
    target: object
    key: string | symbol
  }) => {
    let properties = changed.get(target)

    if (!properties) {
      properties = new Map()
      changed.set(
        target,
        properties,
      )
    }

    if (!properties.has(key)) {
      properties.set(
        key,
        Reflect.getOwnPropertyDescriptor(
          target,
          key,
        ),
      )
    }
  }

  const unwrap = ({ value }: { value: unknown }): unknown => {
    if (value === null || typeof value !== 'object') {
      return value
    }

    const original = originals.get(value)

    if (original) {
      return original
    }

    for (const key of Object.keys(value)) {
      const child: unknown = Reflect.get(
        value,
        key,
      )
      const plain = unwrap({ value: child })

      if (plain !== child) {
        Reflect.set(
          value,
          key,
          plain,
        )
      }
    }

    return value
  }

  const wrap = ({
    value,
    reading,
  }: {
    value: unknown
    reading: boolean
  }): unknown => {
    if (value === null || typeof value !== 'object') {
      return value
    }

    const cache = reading ? readers : writers
    const cached = cache.get(value)

    if (cached) {
      return cached
    }

    const proxy = new Proxy(
      value,
      {
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns this signature.
        get(
          target,
          key,
        ) {
          const properties = changed.get(target)
          const previous = reading && properties?.has(key)
          const child = previous ? properties?.get(key)?.value : Reflect.get(
            target,
            key,
          )

          return wrap({
            value: child,
            reading,
          })
        },
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns this signature.
        has(
          target,
          key,
        ) {
          const properties = changed.get(target)

          if (reading && properties?.has(key)) {
            return properties.get(key) !== undefined
          }

          return Reflect.has(
            target,
            key,
          )
        },
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns this signature.
        ownKeys(target) {
          const keys = new Set(Reflect.ownKeys(target))

          if (reading) {
            for (const [
              key,
              descriptor,
            ] of changed.get(target) ?? []) {
              if (descriptor) {
                keys.add(key)
              } else {
                keys.delete(key)
              }
            }
          }

          return [...keys]
        },
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns this signature.
        getOwnPropertyDescriptor(
          target,
          key,
        ) {
          const properties = changed.get(target)

          if (reading && properties?.has(key)) {
            return properties.get(key)
          }

          return Reflect.getOwnPropertyDescriptor(
            target,
            key,
          )
        },
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns this signature.
        set(
          target,
          key,
          next,
        ) {
          if (reading) {
            throw new Error('Cannot change an event preimage')
          }

          const plain = unwrap({ value: next })

          if (Object.hasOwn(
            target,
            key,
          ) && Reflect.get(
            target,
            key,
          ) === plain) {
            return true
          }

          for (const observe of observers) {
            observe({
              target,
              key,
            })
          }

          if (Array.isArray(target)) {
            for (const observe of observers) {
              observe({
                target,
                key: 'length',
              })
            }

            if (key === 'length' && typeof plain === 'number') {
              for (let index = plain; index < target.length; index++) {
                for (const observe of observers) {
                  observe({
                    target,
                    key: String(index),
                  })
                }
              }
            }
          }

          return Reflect.set(
            target,
            key,
            plain,
          )
        },
        // eslint-disable-next-line pnyx/object-params -- ProxyHandler owns this signature.
        deleteProperty(
          target,
          key,
        ) {
          if (reading) {
            throw new Error('Cannot change an event preimage')
          }

          if (Object.hasOwn(
            target,
            key,
          )) {
            for (const observe of observers) {
              observe({
                target,
                key,
              })
            }
          }

          return Reflect.deleteProperty(
            target,
            key,
          )
        },
      },
    )
    cache.set(
      value,
      proxy,
    )

    if (!reading) {
      originals.set(
        proxy,
        value,
      )
    }

    return proxy
  }

  // A derived append must also preserve each parent event's preimage.
  observers.add(remember)

  try {
    change({
      state: wrap({
        value: state,
        reading: false,
      }) as T,
    })
  } catch (error) {
    observers.delete(remember)
    throw error
  }

  return {
    before: wrap({
      value: state,
      reading: true,
    }) as T,
    release: () => observers.delete(remember),
  }
}
