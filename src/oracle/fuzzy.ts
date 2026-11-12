const trigrams = ({ word }: { word: string }) =>
  Array.from(
    {
      length: Math.max(
        word.length - 2,
        0,
      ),
    },
    (
      _,
      i,
    ) => word.slice(
      i,
      i + 3,
    ),
  )

// Trigram similarity of two words, padded so their first and last letters weigh in.
export function similarity({
  a,
  b,
}: {
  a: string
  b: string
}): number {
  const x = new Set(trigrams({ word: ` ${a} ` }))
  const y = new Set(trigrams({ word: ` ${b} ` }))
  const shared = [...x].filter(t => y.has(t)).length

  return shared / (x.size + y.size - shared)
}
