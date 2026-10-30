// Every Hydra gets one of these names, with the identity icon of the same id in lowercase; a rename keeps the icon.
export const HYDRA_NAMES = [
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
] as const

// The Hydra mark: the icon of a Hydra that has none of its own.
export const HYDRA_MARK = 'hydra'

// The longest name the web lets you type; the server keeps its own wider cap.
export const HYDRA_NAME_MAX = 40

export const HYDRA_ICONS = HYDRA_NAMES.map(name => name.toLowerCase())

export const isHydraIcon = ({ icon }: { icon: string }) =>
  icon === HYDRA_MARK || HYDRA_ICONS.includes(icon)

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
  const unused = HYDRA_NAMES.filter(name => !used.has(name.toLowerCase()))

  const name = unused[Math.floor(random() * unused.length)]

  if (name) {
    return {
      name,
      icon: name.toLowerCase(),
    }
  }

  const first = HYDRA_NAMES[0]
  let n = 2

  while (used.has(`${first} ${n}`.toLowerCase())) {
    n++
  }

  return {
    name: `${first} ${n}`,
    icon: first.toLowerCase(),
  }
}
