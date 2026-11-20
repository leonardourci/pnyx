import type { CSSProperties } from 'react'

const DIMENSIONS = [
  'width',
  'height',
  'left',
  'top',
  'fontSize',
] as const
const TRANSFORMS = [
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

type Dimension = typeof DIMENSIONS[number]
type Transform = typeof TRANSFORMS[number]
type Variable = keyof typeof VARIABLES

export type RuntimeStyle = Partial<Record<Dimension, number | string>>
  & Partial<Record<Transform | Variable, string>>

export function runtimeStyle({ ...values }: RuntimeStyle): CSSProperties {
  const style: Record<string, number | string> = {}

  for (const property of [...DIMENSIONS, ...TRANSFORMS]) {
    const value = values[property]

    if (value !== undefined) {
      style[property] = value
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
