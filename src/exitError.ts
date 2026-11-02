/**
 * An error the CLI ends with exit status `status` instead of 1. It prints the message as any other
 * error does; an empty message prints nothing (the tool already said what happened).
 */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ExitError";
  }
}
