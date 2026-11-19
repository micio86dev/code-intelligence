/** Bad CLI usage or invalid configuration. Maps to exit code 2. */
export class UsageError extends Error {
  readonly details: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "UsageError";
    this.details = details;
  }
}

/** An engine failed to run or produced unusable output. */
export class EngineFailure extends Error {
  readonly kind: "timeout" | "error";
  constructor(kind: "timeout" | "error", message: string) {
    super(message);
    this.name = "EngineFailure";
    this.kind = kind;
  }
}
