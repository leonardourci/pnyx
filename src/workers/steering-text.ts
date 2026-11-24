export const STEERING_NOTICE = 'Othrys steering inbox has pending instruction IDs '
// Transcripts from before the rename hold the Pnyx spelling.
const NOTICE = /^(?:Othrys|Pnyx) steering inbox has pending instruction IDs /
const MESSAGES = /^New instructions for task \S+, in order \((?:Othrys|Pnyx) inbox IDs /

export const steeringText = ({ text }: { text: string }) =>
  NOTICE.test(text) || MESSAGES.test(text)
