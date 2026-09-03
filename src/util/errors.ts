/**
 * The single definition of the "declared but not built yet" error.
 *
 * Every stub module in this repository throws it, naming its own file, so a
 * caller that reaches an unimplemented seam gets a message that says exactly
 * which task still owns the work.
 */
export class NotImplementedError extends Error {
  /** Repository-relative path of the module that has not been implemented. */
  readonly where: string;

  constructor(where: string) {
    super(`not implemented: ${where}`);
    this.name = 'NotImplementedError';
    this.where = where;
  }
}

/**
 * Throwing helper, so a stub body is a single expression and its return type
 * still satisfies the declared signature.
 */
export function notImplemented(where: string): never {
  throw new NotImplementedError(where);
}
