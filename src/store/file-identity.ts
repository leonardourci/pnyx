import type { Stats } from 'node:fs'

export const fileIdentity = ({ stat }: { stat: Stats }) => String(stat.ino)
