/** Base class for expected, user-facing failures (the Python `RuntimeError` family). */
export class GitLibError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
