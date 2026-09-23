import { config, requireBmwCredentials } from "../config.js";

type TokenResponse = { access_token: string; expires_in: string | number; token_type?: string };
let cached: { value: string; expiresAt: number } | undefined;
let pending: Promise<string> | undefined;

async function requestToken(): Promise<string> {
  const { clientId, clientSecret } = requireBmwCredentials();
  const form = new URLSearchParams({ grant_type: "client_credentials", scope: "machine2machine", client_id: clientId, client_secret: clientSecret });
  const response = await fetch(config.BMW_API_ACCESS_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(config.BMW_API_TIMEOUT_MS) });
  const body = await response.json().catch(() => ({})) as Partial<TokenResponse> & { error_description?: string };
  if (!response.ok || typeof body.access_token !== "string") throw new Error(`BMW token endpoint returned HTTP ${response.status}: ${body.error_description ?? "invalid token response"}`);
  const ttl = Math.max(60, Number(body.expires_in) || 3600);
  cached = { value: body.access_token, expiresAt: Date.now() + Math.max(1, ttl - 60) * 1000 };
  return cached.value;
}

export async function getAccessToken(force = false): Promise<string> {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  if (!pending) pending = requestToken().finally(() => { pending = undefined; });
  return pending;
}

export async function renewAccessToken(rejectedToken?: string): Promise<string> {
  if (rejectedToken && cached?.value !== rejectedToken && cached && cached.expiresAt > Date.now()) return cached.value;
  cached = undefined;
  return getAccessToken(true);
}

export function clearTokenCache() { cached = undefined; pending = undefined; }
