import { config, requireBmwCredentials } from "../config.js";
import { createAccessTokenProvider } from "./auth.js";
import { acquireBmwPermit, reportBmw429 } from "./rate-limit.js";
import { exponentialRetryDelay, retryAfterMilliseconds, sleepWithSignal } from "reader-core/shared/retry";

type Json = Record<string, unknown> | unknown[];
export class BmwApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryWindowExhausted = false) { super(message); this.name = "BmwApiError"; }
}
export const sleepUntil = (ms: number, signal?: AbortSignal) => sleepWithSignal(ms, signal).catch(() => { throw new BmwRequestCancelledError(); });
export class BmwRequestCancelledError extends Error {
  constructor() { super("BMW request cancelled"); this.name = "BmwRequestCancelledError"; }
}
export function transientRetryDelay(elapsedMs: number, attempt: number, windowMs: number, retryAfter = 0, jitter = 0) {
  return exponentialRetryDelay(elapsedMs, attempt, windowMs, retryAfter, jitter);
}

export class BmwClient {
  private readonly tokenProvider: ReturnType<typeof createAccessTokenProvider>;
  private readonly credentials = requireBmwCredentials();
  constructor(
    private readonly language = config.BMW_API_LANGUAGE,
    private readonly onRateLimitChange?: (event: { count: number; cooldownMs: number; retryAfterMs: number; recovered?: boolean }) => void | Promise<void>,
    private readonly cancelSignal?: AbortSignal,
    tokenProvider = createAccessTokenProvider(),
    private readonly rateLimiter = { acquire: acquireBmwPermit, report429: reportBmw429 },
  ) { this.tokenProvider = tokenProvider; }

  private async get(path: string, params: Record<string, string>, retryAuth = true, baseUrl = config.BMW_API_BASE_URL): Promise<Json> {
    const url = new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);
    for (const [key, value] of Object.entries({ language: this.language, ...params })) url.searchParams.set(key, value);
    const endpoint = `${url.pathname}${url.search}`;
    let attempt = 0;
    let transientStartedAt: number | undefined;
    let rateLimited = false;
    for (;;) {
      if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
      await this.rateLimiter.acquire(this.cancelSignal);
      if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
      const token = await this.tokenProvider.getAccessToken();
      let response: Response;
      try {
        const timeoutSignal = AbortSignal.timeout(config.BMW_API_TIMEOUT_MS);
        const signal = this.cancelSignal ? AbortSignal.any([timeoutSignal, this.cancelSignal]) : timeoutSignal;
        response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "x-apikey": this.credentials.apiKey, Accept: "application/json" }, signal });
      } catch (error) {
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        transientStartedAt ??= Date.now();
        const elapsed = Date.now() - transientStartedAt;
        const delay = transientRetryDelay(elapsed, attempt, config.BMW_5XX_RETRY_WINDOW_MS, 0, Math.random() * 1000);
        if (delay === null) throw new BmwApiError(`BMW ${endpoint} network request failed after retry window: ${error instanceof Error ? error.message : String(error)}`, 502, true);
        await sleepUntil(delay, this.cancelSignal);
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        if (Date.now() - transientStartedAt >= config.BMW_5XX_RETRY_WINDOW_MS) throw new BmwApiError(`BMW ${endpoint} network request failed after retry window: ${error instanceof Error ? error.message : String(error)}`, 502, true);
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
        const retryDelay = retryAfter > 0 ? Math.min(config.BMW_RATE_LIMIT_MAX_COOLDOWN_MS, retryAfter) : 500;
        await sleepUntil(retryDelay, this.cancelSignal);
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        continue;
      }
      if ([502, 503, 504].includes(response.status)) {
        transientStartedAt ??= Date.now();
        const elapsed = Date.now() - transientStartedAt;
        const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
        const delay = transientRetryDelay(elapsed, attempt, config.BMW_5XX_RETRY_WINDOW_MS, retryAfter, Math.random() * 1000);
        const text = await response.text();
        if (delay === null) {
          throw new BmwApiError(`BMW ${endpoint} returned HTTP ${response.status} after retry window: ${text.slice(0, 300)}`, response.status, true);
        }
        await sleepUntil(delay, this.cancelSignal);
        if (this.cancelSignal?.aborted) throw new BmwRequestCancelledError();
        if (Date.now() - transientStartedAt >= config.BMW_5XX_RETRY_WINDOW_MS) throw new BmwApiError(`BMW ${endpoint} returned HTTP ${response.status} after retry window: ${text.slice(0, 300)}`, response.status, true);
        attempt++;
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new BmwApiError(`BMW ${endpoint} returned HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
      try {
        const result = JSON.parse(text) as Json;
        if (rateLimited) await this.onRateLimitChange?.({ count: 0, cooldownMs: 0, retryAfterMs: 0, recovered: true });
        return result;
      } catch { throw new BmwApiError(`BMW ${endpoint} returned invalid JSON`, response.status); }
    }
  }

  catalog(typekey: string) { return this.get("catalog", { typeCode: typekey }); }
  flatRates(typekey: string, hg: string) { return this.get("", { hg, typeCode: typekey }); }
  inklusivPositionen(typekey: string, awSheetOID: string) { return this.get(`inklusivpositionen/${encodeURIComponent(awSheetOID)}`, { typeCode: typekey }); }
  umfasstTexte(typekey: string, awSheetOID: string) { return this.get(`umfassttexte/${encodeURIComponent(awSheetOID)}`, { typeCode: typekey }); }
  vehicleAttributes(params: Record<string, string>) { return this.get("attributes", params, true, config.BMW_VEHICLE_ID_BASE_URL); }
}
