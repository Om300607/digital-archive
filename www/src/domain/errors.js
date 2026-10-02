// Shared error types. Keeping them in the domain layer lets UI, service and storage agree on them.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Thrown when an archived file can't be opened. `status` is 'missing' | 'unreadable'. */
export class FileUnavailableError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'FileUnavailableError';
    this.status = status;
  }
}

export const abortError = () => new DOMException('Import cancelled', 'AbortError');
export const isAbort = (e) => Boolean(e) && e.name === 'AbortError';
