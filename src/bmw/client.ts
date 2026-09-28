import { config, requireBmwCredentials } from "../config.js";
import { getAccessToken, renewAccessToken } from "./auth.js";
import { acquireBmwPermit, reportBmw429 } from "./rate-limit.js";
import { recordBmwPermit, recordBmwRequest } from "../rate-metrics.js";

type Json = Record<string, unknown> | unknown[];
export class BmwApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs = 0) { super(message); this.name = "BmwApiError"; }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function retryAfterMs(value: string | null) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export class BmwClient {
  private readonly credentials = requireBmwCredentials();
  constructor(
    private readonly language = config.BMW_API_LANGUAGE,
    private readonly permit: () => Promise<void> = acquireBmwPermit,
    private readonly onRateLimitChange?: (event: { count: number; cooldownMs: number; retryAfterMs: number; recovered?: boolean }) => void | Promise<void>,
    private readonly requestId?: string,
  ) {}

  private async get(path: string, params: Record<string, string>, retryAuth = true, baseUrl = config.BMW_API_BASE_URL): Promise<Json> {
    const url = new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);
    for (const [key, value] of Object.entries({ language: this.language, ...params })) url.searchParams.set(key, value);
    let attempt = 0;
    let rateLimited = false;
    for (;;) {
      await this.permit();
      await recordBmwPermit(this.requestId);
      const token = await getAccessToken();
      let response: Response;
      try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "x-apikey": this.credentials.apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(config.BMW_API_TIMEOUT_MS) });
      } catch (error) {
        if (attempt++ >= config.BMW_MAX_RETRIES) throw error;
        await sleep(Math.min(30000, 500 * 2 ** (attempt - 1) + Math.random() * 250));
        continue;
      }
      if (response.status === 404) return [];
      if (response.ok) await recordBmwRequest(this.requestId);
      if (response.status === 401 && retryAuth) {
        await renewAccessToken(token);
        retryAuth = false;
        continue;
      }
      if (response.status === 429) {
        const retryAfter = retryAfterMs(response.headers.get("retry-after"));
        await response.body?.cancel();
        const details = await reportBmw429(retryAfter, Object.fromEntries([...response.headers.entries()].filter(([key]) => /retry-after|rate|quota|limit|reset|date/i.test(key))), this.requestId);
        rateLimited = true;
        await this.onRateLimitChange?.({ count: details.count, cooldownMs: details.waitMs, retryAfterMs: retryAfter });
        const retryDelay = retryAfter > 0 ? Math.min(config.BMW_RATE_LIMIT_MAX_COOLDOWN_MS, retryAfter) : 500;
        await sleep(retryDelay);
        continue;
      }
      if ([502, 503, 504].includes(response.status) && attempt++ < config.BMW_MAX_RETRIES) {
        const retryAfter = retryAfterMs(response.headers.get("retry-after"));
        const backoff = 500 * 2 ** (attempt - 1);
        await sleep(retryAfter > 0 ? retryAfter : Math.min(120000, backoff + Math.random() * 1000));
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new BmwApiError(`BMW API returned HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
      try {
        const result = JSON.parse(text) as Json;
        if (rateLimited) await this.onRateLimitChange?.({ count: 0, cooldownMs: 0, retryAfterMs: 0, recovered: true });
        return result;
      } catch { throw new BmwApiError("BMW API returned invalid JSON", response.status); }
    }
  }

  catalog(typekey: string) { return this.get("catalog", { typeCode: typekey }); }
  flatRates(typekey: string, hg: string) { return this.get("", { hg, typeCode: typekey }); }
  inklusivPositionen(typekey: string, awSheetOID: string) { return this.get(`inklusivpositionen/${encodeURIComponent(awSheetOID)}`, { typeCode: typekey }); }
  umfasstTexte(typekey: string, awSheetOID: string) { return this.get(`umfassttexte/${encodeURIComponent(awSheetOID)}`, { typeCode: typekey }); }
  vehicleAttributes(params: Record<string, string>) { return this.get("attributes", params, true, config.BMW_VEHICLE_ID_BASE_URL); }
}
