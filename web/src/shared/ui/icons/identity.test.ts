import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { HYDRA_ICONS, HYDRA_MARK } from '#hydra/hydra-names.ts'
import { IDENTITY_ICONS } from './identity.ts'

const FOLDER = new URL(
  './identity/',
  import.meta.url,
)

test(
  'every identity icon has its file, every file is in the registry and every Hydra name has its icon',
  () => {
    const files = readdirSync(FOLDER).filter(file => file.endsWith('.svg'))
      .sort()
    const ids = IDENTITY_ICONS.map(icon => icon.id)

    assert.deepEqual(
      IDENTITY_ICONS.map(icon => icon.file).sort(),
      files,
    )
    assert.equal(
      new Set(ids).size,
      ids.length,
      'ids are unique',
    )
    assert.deepEqual(
      [
        HYDRA_MARK,
        ...HYDRA_ICONS,
      ].filter(icon => !ids.includes(icon)),
      [],
    )
  },
)
