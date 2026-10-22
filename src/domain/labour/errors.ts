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

export const TYPEKEY_UNAVAILABLE_CODE = "CGWATB0085";

export class TypekeyUnavailableError extends Error {
  readonly code = TYPEKEY_UNAVAILABLE_CODE;
  constructor(readonly typekey: string) {
    super(`Typekey ${typekey} no disponible en BMW Flat Rates (${TYPEKEY_UNAVAILABLE_CODE})`);
    this.name = "TypekeyUnavailable";
  }
}
