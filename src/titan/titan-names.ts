// Every Titan gets one of these names, with the identity icon of the same id in lowercase; a rename keeps the icon.
const TITAN_NAMES = [
  'Athena',
  'Apollo',
  'Artemis',
  'Hermes',
  'Ares',
  'Hera',
  'Zeus',
  'Poseidon',
  'Hephaestus',
  'Persephone',
  'Demeter',
  'Atlas',
  'Prometheus',
  'Chronos',
  'Helios',
  'Selene',
  'Nyx',
  'Eos',
  'Iris',
  'Nike',
  'Aeolus',
  'Hades',
  'Themis',
  'Kratos',
  'Cronus',
  'Rhea',
  'Hyperion',
  'Mnemosyne',
] as const

// The Titan mark: the icon of a Titan that has none of its own.
export const TITAN_MARK = 'titan'

export const TITAN_NAME_MAX = 40

export const TITAN_ICONS = TITAN_NAMES.map(name => name.toLowerCase())

export const isTitanIcon = ({ icon }: { icon: string }) =>
  icon === TITAN_MARK || TITAN_ICONS.includes(icon)

// A random unused name; once all are taken, the first name with the lowest free number.
export function pickName({
  taken,
  random = Math.random,
}: {
  taken: string[]
  random?(): number
}): {
  name: string
  icon: string
} {
  const used = new Set(taken.map(name => name.trim().toLowerCase()))
  const unused = TITAN_NAMES.filter(name => !used.has(name.toLowerCase()))

  const name = unused[Math.floor(random() * unused.length)]

  if (name) {
    return {
      name,
      icon: name.toLowerCase(),
    }
  }

  const first = TITAN_NAMES[0]
  let n = 2

  while (used.has(`${first} ${n}`.toLowerCase())) {
    n++
  }

  return {
    name: `${first} ${n}`,
    icon: first.toLowerCase(),
  }
}
