export class TypekeyOidFailuresError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypekeyOidFailures";
  }
}

export class TypekeyCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypekeyCancelled";
  }
}
