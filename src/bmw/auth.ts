import { requireBmwCredentials, type AppConfig } from "../config.js";

export type AccessToken = { value: string; expiresAt: number };
type TokenResponse = { access_token: string; expires_in: string | number };

export function nextTokenIndex(current: number, poolSize: number): number {
  if (poolSize < 1) throw new Error("Token pool must have at least one slot");
  return (current + 1) % poolSize;
}

export function tokenExpiresAt(now: number, expiresIn: string | number): number {
  const ttlSeconds = Math.max(60, Number(expiresIn) || 3600);
  return now + Math.max(1, ttlSeconds - 60) * 1000;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class AccessTokenPool {
  private readonly slots: Array<AccessToken | undefined>;
  private readonly pending = new Map<number, { promise: Promise<string>; token?: string }>();
  private index = 0;
  private authNextAt = 0;
  private authQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly size: number,
    private readonly request: () => Promise<TokenResponse>,
    private readonly minAuthSpacingMs = 250,
  ) {
    if (!Number.isInteger(size) || size < 1) throw new Error("BMW_API_TOKEN_POOL_SIZE must be a positive integer");
    this.slots = new Array(size);
  }

  async get(): Promise<string> {
    const slot = this.index;
    this.index = nextTokenIndex(this.index, this.size);
    const cached = this.slots[slot];
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = this.pending.get(slot);
    if (inFlight) return inFlight.promise;
    return this.refresh(slot, cached?.value);
  }

  async renew(rejectedToken?: string): Promise<string> {
    let slot = rejectedToken ? this.slots.findIndex(token => token?.value === rejectedToken) : this.index;
    if (slot < 0) slot = this.index;
    return this.refresh(slot, rejectedToken, true);
  }

  private async refresh(slot: number, rejectedToken?: string, force = false): Promise<string> {
    const cached = this.slots[slot];
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = this.pending.get(slot);
    if (inFlight && (!force || !rejectedToken || inFlight.token !== rejectedToken)) return inFlight.promise;

    const previousToken = cached?.value;
    const promise = this.enqueueAuthRequest().then(token => {
      if (force && rejectedToken && previousToken !== rejectedToken) {
        const otherSlot = this.slots.findIndex((candidate, candidateIndex) => candidateIndex !== slot && candidate?.value === rejectedToken);
        if (otherSlot >= 0) this.slots[otherSlot] = { value: token.access_token, expiresAt: tokenExpiresAt(Date.now(), token.expires_in) };
        return this.slots[otherSlot]?.value ?? token.access_token;
      }
      const value: AccessToken = { value: token.access_token, expiresAt: tokenExpiresAt(Date.now(), token.expires_in) };
      this.slots[slot] = value;
      return value.value;
    }).finally(() => {
      if (this.pending.get(slot)?.promise === promise) this.pending.delete(slot);
    });
    this.pending.set(slot, { promise, token: rejectedToken });
    return promise;
  }

  private enqueueAuthRequest(): Promise<TokenResponse> {
    const request = this.authQueue.then(async () => {
      const waitMs = Math.max(0, this.authNextAt - Date.now());
      if (waitMs) await sleep(waitMs);
      this.authNextAt = Date.now() + this.minAuthSpacingMs;
      return this.request();
    });
    this.authQueue = request.then(() => undefined, () => undefined);
    return request;
  }
}

export function createTokenRequest(settings: Pick<AppConfig, "BMW_API_ACCESS_TOKEN_URL" | "BMW_API_TIMEOUT_MS">, env: NodeJS.ProcessEnv) {
  return async function requestToken(): Promise<TokenResponse> {
  const { clientId, clientSecret } = requireBmwCredentials(env);
  const form = new URLSearchParams({ grant_type: "client_credentials", scope: "machine2machine", client_id: clientId, client_secret: clientSecret });
  const response = await fetch(settings.BMW_API_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(settings.BMW_API_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as Partial<TokenResponse> & { error_description?: string };
  if (!response.ok || typeof body.access_token !== "string") throw new Error(`BMW token endpoint returned HTTP ${response.status}: ${body.error_description ?? "invalid token response"}`);
  return body as TokenResponse;
  };
}

export function createAccessTokenProvider(pool: AccessTokenPool) {
  return { getAccessToken: () => pool.get(), renewAccessToken: (rejectedToken?: string) => pool.renew(rejectedToken) };
}
