export const STEERING_NOTICE = 'Pnyx steering inbox has pending instruction IDs '
const MESSAGES = /^New instructions for task \S+, in order \(Pnyx inbox IDs /

export const steeringText = ({ text }: { text: string }) =>
  text.startsWith(STEERING_NOTICE) || MESSAGES.test(text)
