export interface WriteOptions {
  /** A transaction may cancel before the first byte is written. */
  onStart?: () => void;
  /** Sample the live motion target when the writer is actually available. */
  currentFrame?: () => string;
  /** A release or stop takes the next available write slot. */
  isUrgent?: () => boolean;
}

/** No bytes were written and the connection remains usable. */
export class SkippedWriteError extends Error {}
