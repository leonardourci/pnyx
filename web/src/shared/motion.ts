export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
export type MotionMode = 'normal' | 'off'
export const MOTION_MODE: MotionMode = 'normal'
export const MOTION_DURATIONS = {
  instant: 0,
  fast: 120,
  base: 180,
  slow: 320,
  ambient: 1600,
} as const
export const MOTION_EASING = [
  0.2,
  0.8,
  0.2,
  1,
] as const
export const MOTION_CSS_EASING = `cubic-bezier(${MOTION_EASING.join(', ')})`

export function motionDuration({
  speed = 'base',
  mode = MOTION_MODE,
  reducedMotion = typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION).matches,
}: {
  speed?: keyof typeof MOTION_DURATIONS
  mode?: MotionMode
  reducedMotion?: boolean
} = {}) {
  return mode === 'off' || reducedMotion ? 0 : MOTION_DURATIONS[speed]
}
