import assert from 'node:assert/strict'
import test from 'node:test'
import { HYDRA_NAMES, pickName } from './hydra-names.ts'

test(
  'picks an unused name with its own icon, ignoring case and spaces',
  () => {
    const taken = HYDRA_NAMES.filter(name => name !== 'Kratos').map(name => ` ${name.toUpperCase()} `)

    assert.deepEqual(
      pickName({ taken }),
      {
        name: 'Kratos',
        icon: 'kratos',
      },
    )
  },
)

test(
  'numbers the first name once every name is taken',
  () => {
    assert.deepEqual(
      pickName({
        taken: [
          ...HYDRA_NAMES,
          'athena 2',
        ],
      }),
      {
        name: 'Athena 3',
        icon: 'athena',
      },
    )
  },
)
