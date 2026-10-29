import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { HYDRA_ICONS, HYDRA_MARK } from '#hydra/hydra-names.ts'
import { IDENTITY_ICONS } from './identity.ts'

const FOLDER = new URL(
  './identity/',
  import.meta.url,
)
// icon.tsx draws each file as one inline path in a 512-unit box.
const ONE_PATH = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"><path fill="#000"(?: fill-rule="evenodd")? d="[^"]+"\/><\/svg>\n?$/

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

test(
  'every identity file is one path in a 512-unit box',
  () => {
    for (const file of readdirSync(FOLDER).filter(name => name.endsWith('.svg'))) {
      assert.match(
        readFileSync(
          new URL(
            file,
            FOLDER,
          ),
          'utf8',
        ),
        ONE_PATH,
        file,
      )
    }
  },
)
