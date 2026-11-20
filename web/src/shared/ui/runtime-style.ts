import type { CSSProperties } from 'react'

const LENGTH_PROPERTIES = [
  'width',
  'height',
  'left',
  'top',
  'fontSize',
] as const
const STRING_PROPERTIES = [
  'translate',
  'transformOrigin',
  'transform',
] as const
const VARIABLES = {
  uiFont: '--text-ui',
  chatFont: '--text-chat',
  codeFont: '--text-code',
  projectCardWidth: '--project-card-width',
  sliderFill: '--fill',
} as const

type LengthProperty = typeof LENGTH_PROPERTIES[number]
type StringProperty = typeof STRING_PROPERTIES[number]
type Variable = keyof typeof VARIABLES

export type RuntimeStyle = Partial<Record<LengthProperty, number | string>>
  & Partial<Record<StringProperty | Variable, string>>

export function runtimeStyle({ ...values }: RuntimeStyle): CSSProperties {
  const style: Record<string, string> = {}

  for (const property of LENGTH_PROPERTIES) {
    const value = values[property]

    if (value !== undefined) {
      const variable = `--runtime-${property}`
      style[variable] = typeof value === 'number' ? `${value}px` : value
      style[property] = `var(${variable})`
    }
  }

  for (const property of STRING_PROPERTIES) {
    const value = values[property]

    if (value !== undefined) {
      const variable = `--runtime-${property}`
      style[variable] = value
      style[property] = `var(${variable})`
    }
  }

  for (const property of Object.keys(VARIABLES) as Variable[]) {
    const value = values[property]

    if (value !== undefined) {
      style[VARIABLES[property]] = value
    }
  }

  return style
}
