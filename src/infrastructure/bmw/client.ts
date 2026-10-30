import { requireBmwCredentials, type AppConfig } from "../../config.js";
import { BmwTokenError, type createAccessTokenProvider } from "./auth.js";
import { TYPEKEY_UNAVAILABLE_CODE, TypekeyUnavailableError } from "../../domain/labour/errors.js";
import { exponentialRetryDelay, retryAfterMilliseconds, sleepWithSignal } from "@pablosla/core-reader/shared/retry";

type Json = Record<string, unknown> | unknown[];
class BmwApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryWindowExhausted = false) { super(message); this.name = "BmwApiError"; }
}
export const sleepUntil = (ms: number, signal?: AbortSignal) => sleepWithSignal(ms, signal).catch(() => { throw new BmwRequestCancelledError(); });
export class BmwRequestCancelledError extends Error {
  constructor() { super("BMW request cancelled"); this.name = "BmwRequestCancelledError"; }
}
export class BmwRateLimitWaitTimeoutError extends Error {
  constructor(readonly waitTimeoutMs: number) { super(`BMW rate-limit wait exceeded ${waitTimeoutMs}ms`); this.name = "BmwRateLimitWaitTimeoutError"; }
}
export function transientRetryDelay(elapsedMs: number, attempt: number, windowMs: number, retryAfter = 0, jitter = 0) {
  return exponentialRetryDelay(elapsedMs, attempt, windowMs, retryAfter, jitter);
}

export type BmwRateLimiter = {
  acquire(signal?: AbortSignal, priority?: "interactive" | "normal"): Promise<void>;
  report429(retryAfterMs?: number, headers?: Record<string, string>): Promise<{ waitMs: number; count: number }>;
};

export type BmwClientOptions = {
  settings: AppConfig;
  language: string;
  onRateLimitChange?: (event: { count: number; cooldownMs: number; retryAfterMs: number; recovered?: boolean }) => void | Promise<void>;
  cancelSignal?: AbortSignal;
  tokenProvider: ReturnType<typeof createAccessTokenProvider>;
  rateLimiter: BmwRateLimiter;
};

export type BmwClientOverrides = Partial<Pick<BmwClientOptions, "language" | "onRateLimitChange" | "cancelSignal">>;

export class BmwClient {
  private readonly settings: AppConfig;
  private readonly language: string;
  private readonly onRateLimitChange: BmwClientOptions["onRateLimitChange"];
  private readonly cancelSignal: AbortSignal | undefined;
  private readonly tokenProvider: ReturnType<typeof createAccessTokenProvider>;
  private readonly credentials: ReturnType<typeof requireBmwCredentials>;
  private readonly rateLimiter: BmwRateLimiter;

  constructor(options: BmwClientOptions) {
    this.settings = options.settings;
    this.language = options.language;
    this.onRateLimitChange = options.onRateLimitChange;
    this.cancelSignal = options.cancelSignal;
    this.tokenProvider = options.tokenProvider;
    this.rateLimiter = options.rateLimiter;
    this.credentials = requireBmwCredentials(options.settings);
  }

  private async get(path: string, params: Record<string, string>, retryAuth = true, baseUrl = this.settings.BMW_API_BASE_URL, rateLimitWaitTimeoutMs?: number, rateLimitPriority: "interactive" | "normal" = "normal"): Promise<Json> {
    const url = new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);
    for (const [key, value] of Object.entries({ language: this.language, ...params })) url.searchParams.set(key, value);
    const endpoint = `${url.pathname}${url.search}`;
    let attempt = 0;
    let transientStartedAt: number | undefined;
    let rateLimited = false;
    for (;;) {
      if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
      let waitTimeoutSignal: AbortSignal | undefined;
      let acquireSignal = this.cancelSignal;
      if (rateLimitWaitTimeoutMs !== undefined) {
        waitTimeoutSignal = AbortSignal.timeout(rateLimitWaitTimeoutMs);
        acquireSignal = acquireSignal ? AbortSignal.any([acquireSignal, waitTimeoutSignal]) : waitTimeoutSignal;
      }
      try {
        await this.rateLimiter.acquire(acquireSignal, rateLimitPriority);
      } catch (error) {
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        if (waitTimeoutSignal?.aborted) throw new BmwRateLimitWaitTimeoutError(rateLimitWaitTimeoutMs!);
        throw error;
      }
      if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
      if (waitTimeoutSignal?.aborted) throw new BmwRateLimitWaitTimeoutError(rateLimitWaitTimeoutMs!);
      if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
      let token: string;
      try {
        token = await this.tokenProvider.getAccessToken();
      } catch (error) {
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        // Wrong credentials will not fix themselves; a network or server-side token failure is retried like any other transient error.
        if (!(error instanceof BmwTokenError) || !error.transient) throw error;
        transientStartedAt ??= Date.now();
        const delay = transientRetryDelay(Date.now() - transientStartedAt, attempt, this.settings.BMW_5XX_RETRY_WINDOW_MS, 0, Math.random() * 1000);
        if (delay === null) throw new BmwApiError(`BMW token request failed after retry window: ${error.message}`, 502, true);
        await sleepUntil(delay, this.cancelSignal);
        attempt++;
        continue;
      }
      let response: Response;
      try {
        const timeoutSignal = AbortSignal.timeout(this.settings.BMW_API_TIMEOUT_MS);
        const signal = this.cancelSignal ? AbortSignal.any([timeoutSignal, this.cancelSignal]) : timeoutSignal;
        response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "x-apikey": this.credentials.apiKey, Accept: "application/json" }, signal });
      } catch (error) {
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        transientStartedAt ??= Date.now();
        const elapsed = Date.now() - transientStartedAt;
        const delay = transientRetryDelay(elapsed, attempt, this.settings.BMW_5XX_RETRY_WINDOW_MS, 0, Math.random() * 1000);
        if (delay === null) throw new BmwApiError(`BMW ${endpoint} network request failed after retry window: ${error instanceof Error ? error.message : String(error)}`, 502, true);
        await sleepUntil(delay, this.cancelSignal);
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        if (Date.now() - transientStartedAt >= this.settings.BMW_5XX_RETRY_WINDOW_MS) throw new BmwApiError(`BMW ${endpoint} network request failed after retry window: ${error instanceof Error ? error.message : String(error)}`, 502, true);
        attempt++;
        continue;
      }
      if (response.status === 404) {
        await response.body?.cancel();
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        return [];
      }
      if (response.status === 401 && retryAuth) {
        await response.body?.cancel();
        await this.tokenProvider.renewAccessToken(token);
        retryAuth = false;
        continue;
      }
      if (response.status === 429) {
        const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
        await response.body?.cancel();
        const details = await this.rateLimiter.report429(retryAfter, Object.fromEntries([...response.headers.entries()].filter(([key]) => /retry-after|rate|quota|limit|reset|date/i.test(key))));
        rateLimited = true;
        await this.onRateLimitChange?.({ count: details.count, cooldownMs: details.waitMs, retryAfterMs: retryAfter });
        const retryDelay = retryAfter > 0 ? Math.min(this.settings.BMW_RATE_LIMIT_MAX_COOLDOWN_MS, retryAfter) : 500;
        if (rateLimitWaitTimeoutMs !== undefined && retryDelay > rateLimitWaitTimeoutMs) throw new BmwRateLimitWaitTimeoutError(rateLimitWaitTimeoutMs);
        await sleepUntil(retryDelay, this.cancelSignal);
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        continue;
      }
      if ([502, 503, 504].includes(response.status)) {
        transientStartedAt ??= Date.now();
        const elapsed = Date.now() - transientStartedAt;
        const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
        const delay = transientRetryDelay(elapsed, attempt, this.settings.BMW_5XX_RETRY_WINDOW_MS, retryAfter, Math.random() * 1000);
        const text = await response.text();
        if (delay === null) {
          throw new BmwApiError(`BMW ${endpoint} returned HTTP ${response.status} after retry window: ${text.slice(0, 300)}`, response.status, true);
        }
        await sleepUntil(delay, this.cancelSignal);
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        if (Date.now() - transientStartedAt >= this.settings.BMW_5XX_RETRY_WINDOW_MS) throw new BmwApiError(`BMW ${endpoint} returned HTTP ${response.status} after retry window: ${text.slice(0, 300)}`, response.status, true);
        attempt++;
        continue;
      }
      const text = await response.text();
      if (response.status === 403 && params.typeCode && text.includes(TYPEKEY_UNAVAILABLE_CODE)) throw new TypekeyUnavailableError(params.typeCode);
      if (!response.ok) throw new BmwApiError(`BMW ${endpoint} returned HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
      try {
        const result = JSON.parse(text) as Json;
        if (rateLimited) await this.onRateLimitChange?.({ count: 0, cooldownMs: 0, retryAfterMs: 0, recovered: true });
        return result;
      } catch { throw new BmwApiError(`BMW ${endpoint} returned invalid JSON`, response.status); }
    }
  }

  catalog(typekey: string) { return this.get("catalog", { typeCode: typekey }); }
  catalogInteractive(typekey: string, rateLimitWaitTimeoutMs: number) { return this.get("catalog", { typeCode: typekey }, true, this.settings.BMW_API_BASE_URL, rateLimitWaitTimeoutMs, "interactive"); }
  flatRates(typekey: string, hg: string) { return this.get("", { hg, typeCode: typekey }); }
  inklusivPositionen(typekey: string, awSheetOID: string) { return this.get(`inklusivpositionen/${encodeURIComponent(awSheetOID)}`, { typeCode: typekey }); }
  umfasstTexte(typekey: string, awSheetOID: string) { return this.get(`umfassttexte/${encodeURIComponent(awSheetOID)}`, { typeCode: typekey }); }
  vehicleAttributes(params: Record<string, string>, rateLimitWaitTimeoutMs?: number) { return this.get("attributes", params, true, this.settings.BMW_VEHICLE_ID_BASE_URL, rateLimitWaitTimeoutMs, "interactive"); }
}
