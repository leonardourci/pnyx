// An image attached to a message travels as an `[image: <path>]` line, so every route
// carries it as text and hosted sessions also receive the file itself.
export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
} as const
export type ImageType = (typeof IMAGE_TYPES)[keyof typeof IMAGE_TYPES]
// Claude takes images up to 5 MB once base64 encoded, which adds a third.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024 * 3 / 4
const EXTENSIONS = Object.keys(IMAGE_TYPES).map(extension => extension.slice(1))
  .join('|')
export const ATTACHMENT_NAME = new RegExp(`^[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}\\.(?:${EXTENSIONS})$`)
const LINE = /^\[image: (\/[^\]\n]+)\]$/gm

export const imageLine = ({ path }: { path: string }) => `[image: ${path}]`

export const imageExtension = ({ type }: { type: string }) =>
  Object.entries(IMAGE_TYPES).find(([
    , known,
  ]) => known === type)?.[0]

export const imageType = ({ path }: { path: string }): ImageType | undefined =>
  IMAGE_TYPES[(/\.\w+$/.exec(path)?.[0] ?? '') as keyof typeof IMAGE_TYPES]

export const imagePaths = ({ text }: { text: string }) =>
  [...text.matchAll(LINE)].map(match => match[1]!)

// Only files Pnyx stored for a Hydra are sent as images; any other path stays text.
export function attachedImages({
  text,
  hydras,
}: {
  text: string
  hydras: string
}): string[] {
  return imagePaths({ text }).filter(path => {
    const parts = path.slice(hydras.length + 1).split('/')

    return path.startsWith(`${hydras}/`) && parts.length === 3 && parts[1] === 'attachments'
      && ATTACHMENT_NAME.test(parts[2]!) && !parts[0]!.startsWith('.')
  })
}
