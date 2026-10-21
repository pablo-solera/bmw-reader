export class TypekeyOidFailuresError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypekeyOidFailures";
  }
}

export class TypekeyCancelledByRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypekeyCancelledByRequest";
  }
}
