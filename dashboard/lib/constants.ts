export const SIGNALS = {
  RECEIVE_MESSAGE: 'receiveMessage',
  COMMAND: 'command',
  PLAYER_REPORT: 'playerReport',
  SET_PART: 'setPart',
  SET_NAME: 'setName',
  SHUTDOWN: 'shutdown',
  MARK_DELIVERED: 'markDelivered',
  RECORD_SENT_MESSAGE: 'recordSentMessage',
} as const;

export const QUERIES = {
  GET_METADATA: 'getMetadata',
  GET_PART: 'getPart',
  PENDING_MESSAGES: 'pendingMessages',
  ALL_MESSAGES: 'allMessages',
  HISTORY: 'history',
  ALL_SENT_MESSAGES: 'allSentMessages',
} as const;

export const POLL_INTERVALS = {
  PLAYERS: 3000,
  CONDUCTOR_HISTORY: 3000,
  PLAYER_DETAIL: 3000,
} as const;
