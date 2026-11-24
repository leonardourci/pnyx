import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { pickName, TITAN_ICONS, isTitanIcon } from '#titan/titan-names.ts'
import { IDENTITY_ICONS } from '#web-shared/ui/icons/identity.ts'

const additions = [
  'Cronus',
  'Rhea',
  'Hyperion',
  'Mnemosyne',
]

it(
  'offers each added Titan as an unused random default with a renderable icon',
  () => {
    const taken = TITAN_ICONS.filter(icon => !additions.some(name => name.toLowerCase() === icon))

    for (const name of additions) {
      const picked = pickName({
        taken,
        random: () => 0,
      })
      expect(picked).toEqual({
        name,
        icon: name.toLowerCase(),
      })
      expect(isTitanIcon({ icon: picked.icon })).toBe(true)
      const icon = IDENTITY_ICONS.find(icon => icon.id === picked.icon)
      expect(icon?.kind).toBe('hydra')
      expect(existsSync(new URL(
        `../web/src/shared/ui/icons/identity/${icon?.file}`,
        import.meta.url,
      ))).toBe(true)
      taken.push(name)
    }
  },
)

it(
  'retains existing names and avoids custom names case insensitively',
  () => {
    for (const name of [
      'poseidon',
      'hades',
      'atlas',
      'prometheus',
      'themis',
    ]) {
      expect(TITAN_ICONS).toContain(name)
    }

    const picked = pickName({
      taken: TITAN_ICONS,
      random: () => 0,
    })
    expect(picked).toEqual({
      name: 'Athena 2',
      icon: 'athena',
    })
    expect(pickName({
      taken: [
        ...TITAN_ICONS,
        ' ATHENA 2 ',
      ],
      random: () => 0,
    }).name).toBe('Athena 3')
  },
)

it(
  'keeps added glyphs compatible with the single-path current-color renderer',
  () => {
    for (const name of additions) {
      const icon = IDENTITY_ICONS.find(icon => icon.id === name.toLowerCase())!
      const source = readFileSync(
        new URL(
          `../web/src/shared/ui/icons/identity/${icon.file}`,
          import.meta.url,
        ),
        'utf8',
      )
      expect(source.match(/<path /g)).toHaveLength(1)
      expect(source).not.toMatch(/<(circle|rect|polygon|line)\b/)
    }
  },
)

it(
  'credits each added Titan icon to its game-icons.net source',
  () => {
    for (const name of additions) {
      const icon = IDENTITY_ICONS.find(icon => icon.id === name.toLowerCase())!
      expect(icon).toMatchObject({
        author: 'Lorc',
        license: 'CC BY 3.0',
      })
      expect(icon.source).toMatch(/^https:\/\/game-icons\.net\/1x1\/lorc\/[a-z-]+\.html$/)
    }
  },
)
