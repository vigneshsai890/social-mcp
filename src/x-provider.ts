import { Buffer } from "node:buffer";
import { SocialProviderError } from "./errors.js";
import type { Clock, HttpClient, HttpRequest, HttpResponse, OAuthTokens, Sleep, TokenStore } from "./ports.js";
import {
  SocialProvider,
  type AnalyticsInput,
  type PostAnalytics,
  type PublishedPost,
  type PublishInput,
  type ReplyInput,
} from "./social-provider.js";

export interface XProviderOptions {
  readonly http: HttpClient;
  readonly tokenStore: TokenStore;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly apiBaseUrl?: string;
  readonly oauthTokenUrl?: string;
  readonly proactiveRefreshMs?: number;
  readonly maxRateLimitRetries?: number;
  readonly maxRateLimitDelayMs?: number;
}

const DEFAULT_API_BASE_URL = "https://api.x.com";
const DEFAULT_OAUTH_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const DEFAULT_REFRESH_WINDOW_MS = 60_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_MAX_RATE_LIMIT_DELAY_MS = 15 * 60_000;
const MAX_POST_TEXT_LENGTH = 280;
const TOKEN_KEYS = new Set(["accessToken", "refreshToken", "expiresAt"]);
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class XProvider extends SocialProvider {
  private readonly http: HttpClient;
  private readonly tokenStore: TokenStore;
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly clientId: string;
  private readonly clientSecret: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly oauthTokenUrl: string;
  private readonly proactiveRefreshMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly maxRateLimitDelayMs: number;
  private refreshInFlight: Promise<OAuthTokens> | undefined;

  public constructor(options: XProviderOptions) {
    super();
    if (options.clientId.trim().length === 0) {
      throw new SocialProviderError("CONFIGURATION_ERROR", "X OAuth clientId is required", {
        platform: "x",
        operation: "configure",
      });
    }
    this.http = options.http;
    this.tokenStore = options.tokenStore;
    this.clock = options.clock;
    this.sleep = options.sleep;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.oauthTokenUrl = options.oauthTokenUrl ?? DEFAULT_OAUTH_TOKEN_URL;
    this.proactiveRefreshMs = nonNegative(options.proactiveRefreshMs ?? DEFAULT_REFRESH_WINDOW_MS, "proactiveRefreshMs");
    this.maxRateLimitRetries = nonNegativeInteger(
      options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES,
      "maxRateLimitRetries",
    );
    this.maxRateLimitDelayMs = nonNegative(
      options.maxRateLimitDelayMs ?? DEFAULT_MAX_RATE_LIMIT_DELAY_MS,
      "maxRateLimitDelayMs",
    );
  }

  public override async publish(input: PublishInput): Promise<PublishedPost> {
    requireText(input.text);
    const response = await this.authenticatedRequest(
      {
        method: "POST",
        url: `${this.apiBaseUrl}/2/tweets`,
        headers: { "content-type": "application/json" },
        body: { text: input.text },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      "publish",
    );
    return mapPublishedPost(response.data, response.status, "publish");
  }

  public override async reply(input: ReplyInput): Promise<PublishedPost> {
    requireText(input.text);
    requirePostId(input.postId);
    const response = await this.authenticatedRequest(
      {
        method: "POST",
        url: `${this.apiBaseUrl}/2/tweets`,
        headers: { "content-type": "application/json" },
        body: { text: input.text, reply: { in_reply_to_tweet_id: input.postId } },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      "reply",
    );
    return mapPublishedPost(response.data, response.status, "reply");
  }

  public override async analytics(input: AnalyticsInput): Promise<PostAnalytics> {
    requirePostId(input.postId);
    const fields = encodeURIComponent("created_at,public_metrics");
    const response = await this.authenticatedRequest(
      {
        method: "GET",
        url: `${this.apiBaseUrl}/2/tweets/${encodeURIComponent(input.postId)}?tweet.fields=${fields}`,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      "analytics",
    );
    return mapAnalytics(response.data, response.status);
  }

  private async authenticatedRequest(request: HttpRequest, operation: string): Promise<HttpResponse<unknown>> {
    const signal = request.signal;
    let tokens = await this.loadUsableTokens(signal);
    let refreshedAfterUnauthorized = false;
    let rateLimitRetries = 0;

    for (;;) {
      throwIfAborted(signal);
      const response = await this.send({
        ...request,
        headers: { ...request.headers, authorization: `Bearer ${tokens.accessToken}` },
      }, operation);

      if (response.status === 401 && !refreshedAfterUnauthorized) {
        tokens = await this.recoverAfterUnauthorized(tokens, signal);
        refreshedAfterUnauthorized = true;
        continue;
      }

      if (response.status === 429) {
        const retryAfterMs = rateLimitDelayMs(response.headers, this.clock.now(), rateLimitRetries, operation);
        if (rateLimitRetries >= this.maxRateLimitRetries || retryAfterMs > this.maxRateLimitDelayMs) {
          throw new SocialProviderError("RATE_LIMITED", "X API rate limit retry budget exhausted", {
            platform: "x",
            operation,
            status: 429,
            retryable: true,
            details: { retryAfterMs, retries: rateLimitRetries },
          });
        }
        rateLimitRetries += 1;
        await this.sleepForRetry(retryAfterMs, signal, operation);
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw apiError(response.status, operation);
      }
      return response;
    }
  }

  private async recoverAfterUnauthorized(staleTokens: OAuthTokens, signal?: AbortSignal): Promise<OAuthTokens> {
    // Another request or process may have already rotated the refresh token while this 401 was delayed.
    // Reload before refreshing and use the newer generation instead of replaying stale credentials.
    const currentTokens = await this.loadStoredTokens(signal);
    if (!sameTokenGeneration(currentTokens, staleTokens) && this.tokensAreUsable(currentTokens)) {
      return currentTokens;
    }
    return this.refreshTokens(currentTokens, "oauth_refresh_after_401", signal);
  }

  private async loadUsableTokens(signal?: AbortSignal): Promise<OAuthTokens> {
    const tokens = await this.loadStoredTokens(signal);
    if (!this.tokensAreUsable(tokens)) {
      return this.refreshTokens(tokens, "oauth_refresh_proactive", signal);
    }
    return tokens;
  }

  private tokensAreUsable(tokens: OAuthTokens): boolean {
    return tokens.expiresAt > this.clock.now() + this.proactiveRefreshMs;
  }

  private async loadStoredTokens(signal?: AbortSignal): Promise<OAuthTokens> {
    throwIfAborted(signal);
    let value: unknown;
    try {
      value = await this.tokenStore.load();
    } catch {
      throw new SocialProviderError("AUTHENTICATION_ERROR", "Unable to load X OAuth tokens", {
        platform: "x",
        operation: "token_load",
      });
    }
    throwIfAborted(signal);
    return validateStoredTokens(value);
  }

  private refreshTokens(tokens: OAuthTokens, operation: string, signal?: AbortSignal): Promise<OAuthTokens> {
    throwIfAborted(signal);
    if (this.refreshInFlight === undefined) {
      const refresh = this.performRefresh(tokens, operation).finally(() => {
        if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
      });
      this.refreshInFlight = refresh;
    }
    return waitForAbort(this.refreshInFlight, signal);
  }

  private async performRefresh(tokens: OAuthTokens, operation: string, signal?: AbortSignal): Promise<OAuthTokens> {
    if (tokens.refreshToken === undefined) {
      throw new SocialProviderError("AUTHENTICATION_ERROR", "X OAuth refresh token is unavailable", {
        platform: "x",
        operation,
        status: 401,
      });
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: this.clientId,
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.clientSecret !== undefined) {
      headers["authorization"] = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    }
    const request: HttpRequest = {
      method: "POST",
      url: this.oauthTokenUrl,
      headers,
      body: body.toString(),
      ...(signal === undefined ? {} : { signal }),
    };

    let rateLimitRetries = 0;
    let response: HttpResponse<unknown>;
    for (;;) {
      response = await this.send(request, operation);
      if (response.status !== 429) break;

      const retryAfterMs = rateLimitDelayMs(response.headers, this.clock.now(), rateLimitRetries, operation);
      if (rateLimitRetries >= this.maxRateLimitRetries || retryAfterMs > this.maxRateLimitDelayMs) {
        throw new SocialProviderError("AUTHENTICATION_ERROR", "X OAuth token endpoint rate limit retry budget exhausted", {
          platform: "x",
          operation,
          status: 429,
          retryable: true,
          details: { retryAfterMs, retries: rateLimitRetries },
        });
      }
      rateLimitRetries += 1;
      await this.sleepForRetry(retryAfterMs, signal, operation);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SocialProviderError("AUTHENTICATION_ERROR", "X OAuth token refresh failed", {
        platform: "x",
        operation,
        status: response.status,
        retryable: response.status >= 500,
      });
    }

    const tokenResponse = validateTokenResponse(response.data, response.status, operation, this.clock.now());
    const refreshed: OAuthTokens = {
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken ?? tokens.refreshToken,
      expiresAt: tokenResponse.expiresAt,
    };
    throwIfAborted(signal);
    try {
      await this.tokenStore.save(refreshed);
    } catch {
      throw new SocialProviderError("AUTHENTICATION_ERROR", "Unable to persist refreshed X OAuth tokens", {
        platform: "x",
        operation: "token_save",
      });
    }
    throwIfAborted(signal);
    return refreshed;
  }

  private async sleepForRetry(milliseconds: number, signal: AbortSignal | undefined, operation: string): Promise<void> {
    throwIfAborted(signal);
    try {
      await this.sleep(milliseconds, signal);
    } catch {
      throwIfAborted(signal);
      throw new SocialProviderError("NETWORK_ERROR", "X API retry delay failed", {
        platform: "x",
        operation,
        retryable: true,
      });
    }
    throwIfAborted(signal);
  }

  private async send(request: HttpRequest, operation: string): Promise<HttpResponse<unknown>> {
    throwIfAborted(request.signal);
    try {
      return await this.http.request<unknown>(request);
    } catch {
      throwIfAborted(request.signal);
      throw new SocialProviderError("NETWORK_ERROR", "X API transport request failed", {
        platform: "x",
        operation,
        retryable: true,
      });
    }
  }
}

function validateStoredTokens(value: unknown): OAuthTokens {
  const object = objectValue(value);
  if (object === undefined || Object.keys(object).some((key) => !TOKEN_KEYS.has(key))) {
    throw invalidStoredTokens();
  }
  const accessToken = nonEmptyValue(object["accessToken"]);
  const refreshValue = object["refreshToken"];
  const refreshToken = refreshValue === undefined ? undefined : nonEmptyValue(refreshValue);
  const expiresAt = object["expiresAt"];
  if (accessToken === undefined || (refreshValue !== undefined && refreshToken === undefined) || !positiveSafeInteger(expiresAt)) {
    throw invalidStoredTokens();
  }
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt,
  };
}

function invalidStoredTokens(): SocialProviderError {
  return new SocialProviderError("AUTHENTICATION_ERROR", "Stored X OAuth tokens are malformed", {
    platform: "x",
    operation: "token_load",
  });
}

interface ValidTokenResponse {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
}

function validateTokenResponse(
  value: unknown,
  status: number,
  operation: string,
  now: number,
): ValidTokenResponse {
  const object = objectValue(value);
  const accessToken = object === undefined ? undefined : nonEmptyValue(object["access_token"]);
  const refreshValue = object?.["refresh_token"];
  const refreshToken = refreshValue === undefined ? undefined : nonEmptyValue(refreshValue);
  const expiresIn = object?.["expires_in"];
  const tokenType = object?.["token_type"];
  const maximumSeconds = Number.isSafeInteger(now) && now >= 0
    ? Math.floor((Number.MAX_SAFE_INTEGER - now) / 1_000)
    : -1;

  if (
    accessToken === undefined
    || (refreshValue !== undefined && refreshToken === undefined)
    || typeof tokenType !== "string"
    || tokenType.toLowerCase() !== "bearer"
    || !positiveSafeInteger(expiresIn)
    || expiresIn > maximumSeconds
  ) {
    throw invalidResponse("X OAuth refresh response is malformed", operation, status);
  }

  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt: now + expiresIn * 1_000,
  };
}

function mapPublishedPost(value: unknown, status: number, operation: string): PublishedPost {
  const envelope = objectValue(value);
  const tweet = objectValue(envelope?.["data"]);
  const id = nonEmptyValue(tweet?.["id"]);
  const text = nonEmptyValue(tweet?.["text"]);
  if (id === undefined || text === undefined) {
    throw invalidResponse("X publish response is malformed", operation, status);
  }
  return {
    platform: "x",
    postId: id,
    text,
    url: `https://x.com/i/web/status/${id}`,
  };
}

function mapAnalytics(value: unknown, status: number): PostAnalytics {
  const envelope = objectValue(value);
  const tweet = objectValue(envelope?.["data"]);
  const metrics = objectValue(tweet?.["public_metrics"]);
  const id = nonEmptyValue(tweet?.["id"]);
  if (tweet === undefined || id === undefined || metrics === undefined) {
    throw invalidResponse("X analytics response is malformed", "analytics", status);
  }

  const likes = analyticsMetric(metrics["like_count"]);
  const replies = analyticsMetric(metrics["reply_count"]);
  const reposts = analyticsMetric(metrics["retweet_count"]);
  const quotes = analyticsMetric(metrics["quote_count"]);
  const impressions = analyticsMetric(metrics["impression_count"]);
  const bookmarks = analyticsMetric(metrics["bookmark_count"]);
  if (
    likes === undefined
    || replies === undefined
    || reposts === undefined
    || quotes === undefined
    || impressions === undefined
    || bookmarks === undefined
  ) {
    throw invalidResponse("X analytics response contains invalid metrics", "analytics", status);
  }

  const createdValue = tweet["created_at"];
  if (createdValue !== undefined && !isIsoTimestamp(createdValue)) {
    throw invalidResponse("X analytics response contains an invalid timestamp", "analytics", status);
  }

  return {
    platform: "x",
    postId: id,
    ...(createdValue === undefined ? {} : { createdAt: createdValue }),
    metrics: { likes, replies, reposts, quotes, impressions, bookmarks },
  };
}

function analyticsMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const canonical = new Date(milliseconds).toISOString();
  return value.includes(".") ? canonical === value : canonical.replace(".000Z", "Z") === value;
}

function invalidResponse(message: string, operation: string, status: number): SocialProviderError {
  return new SocialProviderError("INVALID_RESPONSE", message, {
    platform: "x",
    operation,
    status,
  });
}

function apiError(status: number, operation: string): SocialProviderError {
  return new SocialProviderError(status === 401 ? "AUTHENTICATION_ERROR" : "API_ERROR", "X API request failed", {
    platform: "x",
    operation,
    status,
    retryable: status >= 500,
  });
}

function rateLimitDelayMs(
  headers: Readonly<Record<string, string | undefined>>,
  now: number,
  retryNumber: number,
  operation: string,
): number {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const candidates: number[] = [];

  if (normalized.has("retry-after")) {
    const parsed = parseRetryAfter(normalized.get("retry-after"), now);
    if (parsed === undefined) throw malformedRateLimitHeader(operation);
    candidates.push(parsed);
  }
  if (normalized.has("x-rate-limit-reset")) {
    const parsed = parseRateLimitReset(normalized.get("x-rate-limit-reset"), now);
    if (parsed === undefined) throw malformedRateLimitHeader(operation);
    candidates.push(parsed);
  }

  return candidates.length === 0 ? 1_000 * 2 ** retryNumber : Math.max(...candidates);
}

function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) && seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
      ? seconds * 1_000
      : undefined;
  }
  const httpDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  if (!httpDate.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) && new Date(date).toUTCString() === trimmed
    ? Math.max(0, date - now)
    : undefined;
}

function parseRateLimitReset(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const epochSeconds = Number(trimmed);
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    return undefined;
  }
  return Math.max(0, epochSeconds * 1_000 - now);
}

function malformedRateLimitHeader(operation: string): SocialProviderError {
  return new SocialProviderError("INVALID_RESPONSE", "X rate limit response contains a malformed retry header", {
    platform: "x",
    operation,
    status: 429,
  });
}

function requireText(text: string): void {
  if (typeof text !== "string" || text.trim().length === 0 || Array.from(text).length > MAX_POST_TEXT_LENGTH) {
    throw new SocialProviderError(
      "CONFIGURATION_ERROR",
      `Post text must contain between 1 and ${MAX_POST_TEXT_LENGTH} characters`,
      { platform: "x", operation: "validate" },
    );
  }
}

function requirePostId(postId: string): void {
  if (typeof postId !== "string" || postId.trim().length === 0) {
    throw new SocialProviderError("CONFIGURATION_ERROR", "Post id must not be empty", {
      platform: "x",
      operation: "validate",
    });
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameTokenGeneration(left: OAuthTokens, right: OAuthTokens): boolean {
  return left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken
    && left.expiresAt === right.expiresAt;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}


function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error("Operation aborted"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new SocialProviderError("CONFIGURATION_ERROR", `${name} must be a non-negative number`, {
      platform: "x",
      operation: "configure",
    });
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value)) return nonNegative(-1, name);
  return nonNegative(value, name);
}
