/** Base class for expected, user-facing failures (the Python `RuntimeError` family). */
export class GitLibError extends Error {
  /**
   * What `isGitLibError` looks for. A dev server that reloads modules, or a bundle holding two copies of this
   * package, makes `instanceof GitLibError` false for an error thrown by the other copy.
   */
  readonly isGitLibError = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Like `error instanceof GitLibError`, but also true for one thrown by another loaded copy of this package. */
export function isGitLibError(error: unknown): error is GitLibError {
  return error instanceof Error && (error as { isGitLibError?: unknown }).isGitLibError === true;
}
