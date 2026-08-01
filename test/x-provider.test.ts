import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HttpClient, HttpRequest, HttpResponse, OAuthTokens, TokenStore } from "../src/ports.js";
import { XProvider } from "../src/x-provider.js";

class QueueHttpClient implements HttpClient {
  public readonly requests: HttpRequest[] = [];
  public constructor(private readonly responses: Array<HttpResponse<unknown>>) {}

  public async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.requests.push(request);
    const response = this.responses.shift();
    assert.ok(response, "unexpected HTTP request");
    return response as HttpResponse<T>;
  }
}

class MemoryTokenStore implements TokenStore {
  public readonly saved: OAuthTokens[] = [];
  public constructor(public tokens: OAuthTokens) {}
  public async load(): Promise<OAuthTokens> { return this.tokens; }
  public async save(tokens: OAuthTokens): Promise<void> {
    this.tokens = tokens;
    this.saved.push(tokens);
  }
}

class Deferred {
  public readonly promise: Promise<void>;
  private resolvePromise: (() => void) | undefined;

  public constructor() {
    this.promise = new Promise((resolve) => { this.resolvePromise = resolve; });
  }

  public resolve(): void {
    this.resolvePromise?.();
  }
}

const now = 1_800_000_000_000;
const okHeaders = {} as const;
const validTokens: OAuthTokens = {
  accessToken: "access-old",
  refreshToken: "refresh-secret",
  expiresAt: now + 3_600_000,
};

function provider(
  responses: Array<HttpResponse<unknown>>,
  tokens: OAuthTokens = validTokens,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void> = async () => undefined,
  limits: { readonly maxRateLimitRetries?: number; readonly maxRateLimitDelayMs?: number } = {},
): { readonly value: XProvider; readonly http: QueueHttpClient; readonly store: MemoryTokenStore } {
  const http = new QueueHttpClient(responses);
  const store = new MemoryTokenStore(tokens);
  return {
    http,
    store,
    value: new XProvider({
      http,
      tokenStore: store,
      clock: { now: () => now },
      sleep,
      clientId: "client-id",
      apiBaseUrl: "https://x.test",
      oauthTokenUrl: "https://x.test/oauth/token",
      ...limits,
    }),
  };
}

function assertErrorCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { readonly code?: string }).code, code);
    return true;
  };
}

function tweetData(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    data: {
      id: "10",
      created_at: "2026-01-01T00:00:00.000Z",
      public_metrics: {
        like_count: 1,
        reply_count: 2,
        retweet_count: 3,
        quote_count: 4,
        impression_count: 5,
        bookmark_count: 6,
      },
      ...overrides,
    },
  };
}

describe("XProvider", () => {
  it("maps X v2 publish, reply, and analytics requests and responses", async () => {
    const fixture = provider([
      { status: 201, headers: okHeaders, data: { data: { id: "10", text: "hello" } } },
      { status: 201, headers: okHeaders, data: { data: { id: "11", text: "reply" } } },
      { status: 200, headers: okHeaders, data: tweetData() },
    ]);

    assert.deepEqual(await fixture.value.publish({ text: "hello" }), {
      platform: "x", postId: "10", text: "hello", url: "https://x.com/i/web/status/10",
    });
    assert.deepEqual(await fixture.value.reply({ postId: "10", text: "reply" }), {
      platform: "x", postId: "11", text: "reply", url: "https://x.com/i/web/status/11",
    });
    assert.deepEqual(await fixture.value.analytics({ postId: "10" }), {
      platform: "x",
      postId: "10",
      createdAt: "2026-01-01T00:00:00.000Z",
      metrics: { likes: 1, replies: 2, reposts: 3, quotes: 4, impressions: 5, bookmarks: 6 },
    });
    assert.deepEqual(fixture.http.requests[1]?.body, {
      text: "reply", reply: { in_reply_to_tweet_id: "10" },
    });
    assert.match(fixture.http.requests[2]?.url ?? "", /\/2\/tweets\/10\?tweet\.fields=/);
  });

  it("refreshes proactively and saves rotated OAuth tokens", async () => {
    const fixture = provider(
      [
        {
          status: 200,
          headers: okHeaders,
          data: { access_token: "access-new", refresh_token: "refresh-new", expires_in: 7200, token_type: "bearer" },
        },
        { status: 201, headers: okHeaders, data: { data: { id: "20", text: "fresh" } } },
      ],
      { accessToken: "expired-secret", refreshToken: "refresh-secret", expiresAt: now + 10_000 },
    );

    await fixture.value.publish({ text: "fresh" });
    assert.equal(fixture.http.requests[0]?.url, "https://x.test/oauth/token");
    assert.equal(fixture.http.requests[1]?.headers?.["authorization"], "Bearer access-new");
    assert.equal(fixture.store.saved[0]?.refreshToken, "refresh-new");
  });

  it("refreshes once on 401 and transparently retries with the new access token", async () => {
    const fixture = provider([
      { status: 401, headers: okHeaders, data: { title: "Unauthorized" } },
      { status: 200, headers: okHeaders, data: { access_token: "access-new", expires_in: 3600, token_type: "Bearer" } },
      { status: 201, headers: okHeaders, data: { data: { id: "30", text: "retried" } } },
    ]);

    await fixture.value.publish({ text: "retried" });
    assert.equal(fixture.http.requests.length, 3);
    assert.equal(fixture.http.requests[2]?.headers?.["authorization"], "Bearer access-new");
  });

  it("reloads the current token generation after a delayed concurrent 401", async () => {
    const delayedStarted = new Deferred();
    const releaseDelayed401 = new Deferred();
    const store = new MemoryTokenStore(validTokens);
    const requests: HttpRequest[] = [];
    let refreshRequests = 0;
    const http: HttpClient = {
      request: async <T>(request: HttpRequest): Promise<HttpResponse<T>> => {
        requests.push(request);
        if (request.url.endsWith("/oauth/token")) {
          refreshRequests += 1;
          return {
            status: 200,
            headers: okHeaders,
            data: {
              access_token: "access-new",
              refresh_token: "refresh-new",
              expires_in: 3600,
              token_type: "bearer",
            },
          } as HttpResponse<T>;
        }
        const body = request.body as { readonly text?: string } | undefined;
        if (request.headers?.["authorization"] === "Bearer access-old") {
          if (body?.text === "delayed") {
            delayedStarted.resolve();
            await releaseDelayed401.promise;
          }
          return { status: 401, headers: okHeaders, data: null } as HttpResponse<T>;
        }
        return {
          status: 201,
          headers: okHeaders,
          data: { data: { id: body?.text === "delayed" ? "42" : "41", text: body?.text } },
        } as HttpResponse<T>;
      },
    };
    const value = new XProvider({
      http,
      tokenStore: store,
      clock: { now: () => now },
      sleep: async () => undefined,
      clientId: "client-id",
      apiBaseUrl: "https://x.test",
      oauthTokenUrl: "https://x.test/oauth/token",
    });

    const delayed = value.publish({ text: "delayed" });
    await delayedStarted.promise;
    await value.publish({ text: "immediate" });
    releaseDelayed401.resolve();
    await delayed;

    assert.equal(refreshRequests, 1, "the delayed 401 must not reuse the rotated refresh token");
    assert.equal(store.tokens.refreshToken, "refresh-new");
    const delayedAuthorizations = requests
      .filter((request) => (request.body as { readonly text?: string } | undefined)?.text === "delayed")
      .map((request) => request.headers?.["authorization"]);
    assert.deepEqual(delayedAuthorizations, ["Bearer access-old", "Bearer access-new"]);
  });

  it("strictly rejects null and malformed stored token payloads", async () => {
    const malformed: unknown[] = [
      null,
      [],
      {},
      { accessToken: "", refreshToken: "refresh", expiresAt: now + 1_000 },
      { accessToken: "access", refreshToken: "", expiresAt: now + 1_000 },
      { accessToken: "access", expiresAt: 0 },
      { accessToken: "access", expiresAt: Number.MAX_VALUE },
      { accessToken: "access", expiresAt: now + 1_000, unexpected: true },
    ];

    for (const stored of malformed) {
      const tokenStore: TokenStore = {
        load: async () => stored as OAuthTokens,
        save: async () => undefined,
      };
      const value = new XProvider({
        http: new QueueHttpClient([]),
        tokenStore,
        clock: { now: () => now },
        sleep: async () => undefined,
        clientId: "client-id",
      });
      await assert.rejects(value.publish({ text: "test" }), assertErrorCode("AUTHENTICATION_ERROR"));
    }
  });

  it("strictly rejects malformed token endpoint payloads, expiry, and token type", async () => {
    const malformed: unknown[] = [
      null,
      {},
      { access_token: "access", expires_in: 0, token_type: "bearer" },
      { access_token: "access", expires_in: -1, token_type: "bearer" },
      { access_token: "access", expires_in: 1.5, token_type: "bearer" },
      { access_token: "access", expires_in: Number.MAX_SAFE_INTEGER, token_type: "bearer" },
      { access_token: "access", expires_in: 3600, token_type: "Basic" },
      { access_token: "access", refresh_token: "", expires_in: 3600, token_type: "bearer" },
    ];

    for (const data of malformed) {
      const fixture = provider(
        [{ status: 200, headers: okHeaders, data }],
        { accessToken: "expired", refreshToken: "refresh-secret", expiresAt: now + 1 },
      );
      await assert.rejects(fixture.value.publish({ text: "test" }), assertErrorCode("INVALID_RESPONSE"));
      assert.equal(fixture.store.saved.length, 0);
    }
  });

  it("strictly rejects null or malformed tweet and analytics payloads", async () => {
    const publishPayloads: unknown[] = [
      null,
      {},
      { data: null },
      { data: { id: "", text: "x" } },
      { data: { id: "1", text: "" } },
      { data: { id: "1" } },
    ];
    for (const data of publishPayloads) {
      const fixture = provider([{ status: 201, headers: okHeaders, data }]);
      await assert.rejects(fixture.value.publish({ text: "test" }), assertErrorCode("INVALID_RESPONSE"));
    }

    const analyticsPayloads: unknown[] = [
      null,
      {},
      tweetData({ public_metrics: null }),
      tweetData({
        public_metrics: {
          like_count: -1,
          reply_count: 2,
          retweet_count: 3,
          quote_count: 4,
          impression_count: 5,
          bookmark_count: 6,
        },
      }),
      tweetData({
        public_metrics: {
          like_count: 1.5,
          reply_count: 2,
          retweet_count: 3,
          quote_count: 4,
          impression_count: 5,
          bookmark_count: 6,
        },
      }),
      tweetData({ created_at: "2026-02-30T00:00:00.000Z" }),
    ];
    for (const data of analyticsPayloads) {
      const fixture = provider([{ status: 200, headers: okHeaders, data }]);
      await assert.rejects(fixture.value.analytics({ postId: "10" }), assertErrorCode("INVALID_RESPONSE"));
    }
  });

  it("retries a shared token-endpoint 429 within bounds without coupling it to a caller signal", async () => {
    const sleeps: Array<{ readonly milliseconds: number; readonly signal?: AbortSignal }> = [];
    const controller = new AbortController();
    const fixture = provider(
      [
        { status: 429, headers: { "retry-after": "2" }, data: null },
        {
          status: 200,
          headers: okHeaders,
          data: { access_token: "access-new", expires_in: 3600, token_type: "bearer" },
        },
        { status: 201, headers: okHeaders, data: { data: { id: "50", text: "after refresh" } } },
      ],
      { accessToken: "expired", refreshToken: "refresh-secret", expiresAt: now + 1 },
      async (milliseconds, signal) => { sleeps.push({ milliseconds, ...(signal === undefined ? {} : { signal }) }); },
    );

    await fixture.value.publish({ text: "after refresh", signal: controller.signal });
    assert.deepEqual(sleeps, [{ milliseconds: 2_000 }]);
    const tokenRequests = fixture.http.requests.filter((request) => request.url.endsWith("/oauth/token"));
    const postRequests = fixture.http.requests.filter((request) => !request.url.endsWith("/oauth/token"));
    assert.equal(tokenRequests.length, 2);
    assert.ok(tokenRequests.every((request) => request.signal === undefined));
    assert.ok(postRequests.every((request) => request.signal === controller.signal));
  });

  it("rejects empty or malformed rate-limit headers instead of treating them as zero or fallback", async () => {
    for (const headers of [
      { "retry-after": "" },
      { "retry-after": "not-a-delay" },
      { "retry-after": "12.5" },
      { "x-rate-limit-reset": " " },
      { "x-rate-limit-reset": "12.5" },
    ]) {
      const sleeps: number[] = [];
      const fixture = provider(
        [{ status: 429, headers, data: null }],
        undefined,
        async (milliseconds) => { sleeps.push(milliseconds); },
      );
      await assert.rejects(fixture.value.publish({ text: "test" }), assertErrorCode("INVALID_RESPONSE"));
      assert.deepEqual(sleeps, []);
    }
  });

  it("respects retry-after and x-rate-limit-reset before bounded transparent retry", async () => {
    const sleeps: number[] = [];
    const fixture = provider(
      [
        {
          status: 429,
          headers: { "retry-after": "2", "x-rate-limit-reset": String((now + 3_000) / 1_000) },
          data: { title: "Too Many Requests" },
        },
        { status: 201, headers: okHeaders, data: { data: { id: "40", text: "later" } } },
      ],
      undefined,
      async (milliseconds) => { sleeps.push(milliseconds); },
    );

    await fixture.value.publish({ text: "later" });
    assert.deepEqual(sleeps, [3_000]);
    assert.equal(fixture.http.requests.length, 2);
  });

  it("stops after the bounded 429 retry budget and exposes no credentials in its structured error", async () => {
    const sleeps: number[] = [];
    const fixture = provider(
      [
        { status: 429, headers: okHeaders, data: { title: "Limited", detail: "access-old refresh-secret" } },
        { status: 429, headers: okHeaders, data: { title: "Limited", detail: "access-old refresh-secret" } },
        { status: 429, headers: okHeaders, data: { title: "Limited", detail: "access-old refresh-secret" } },
      ],
      undefined,
      async (milliseconds) => { sleeps.push(milliseconds); },
    );

    await assert.rejects(
      fixture.value.publish({ text: "bounded" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const serialized = JSON.stringify(error);
        assert.match(serialized, /RATE_LIMITED/);
        assert.doesNotMatch(serialized, /access-old|refresh-secret/);
        return true;
      },
    );
    assert.deepEqual(sleeps, [1_000, 2_000]);
    assert.equal(fixture.http.requests.length, 3);
  });

  it("does not retain secret-bearing transport, token-load, or token-save causes", async () => {
    const secret = "credential-secret-in-cause";
    const assertSanitized = (error: unknown): boolean => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { readonly cause?: unknown }).cause, undefined);
      assert.doesNotMatch(`${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`, new RegExp(secret));
      return true;
    };

    const transportProvider = new XProvider({
      http: { request: async () => { throw new Error(secret); } },
      tokenStore: new MemoryTokenStore(validTokens),
      clock: { now: () => now },
      sleep: async () => undefined,
      clientId: "client-id",
    });
    await assert.rejects(transportProvider.publish({ text: "test" }), assertSanitized);

    const loadProvider = new XProvider({
      http: new QueueHttpClient([]),
      tokenStore: { load: async () => { throw new Error(secret); }, save: async () => undefined },
      clock: { now: () => now },
      sleep: async () => undefined,
      clientId: "client-id",
    });
    await assert.rejects(loadProvider.publish({ text: "test" }), assertSanitized);

    const saveProvider = new XProvider({
      http: new QueueHttpClient([{
        status: 200,
        headers: okHeaders,
        data: { access_token: "new", expires_in: 3600, token_type: "bearer" },
      }]),
      tokenStore: {
        load: async () => ({ accessToken: "expired", refreshToken: "refresh", expiresAt: now + 1 }),
        save: async () => { throw new Error(secret); },
      },
      clock: { now: () => now },
      sleep: async () => undefined,
      clientId: "client-id",
    });
    await assert.rejects(saveProvider.publish({ text: "test" }), assertSanitized);
  });

  it("enforces the same 280-character post limit at the provider boundary", async () => {
    const fixture = provider([]);
    await assert.rejects(fixture.value.publish({ text: "x".repeat(281) }), assertErrorCode("CONFIGURATION_ERROR"));
    assert.equal(fixture.http.requests.length, 0);
  });
});


describe("XProvider token refresh retry bounds", () => {
  it("does not sleep or retry when token-endpoint Retry-After exceeds the delay cap", async () => {
    const sleeps: number[] = [];
    const fixture = provider(
      [{ status: 429, headers: { "retry-after": "2" }, data: null }],
      { accessToken: "expired", refreshToken: "refresh-secret", expiresAt: now + 1 },
      async (milliseconds) => { sleeps.push(milliseconds); },
      { maxRateLimitDelayMs: 1_000 },
    );

    await assert.rejects(fixture.value.publish({ text: "test" }), assertErrorCode("AUTHENTICATION_ERROR"));
    assert.deepEqual(sleeps, []);
    assert.equal(fixture.http.requests.length, 1);
  });
});


describe("XProvider shared refresh cancellation", () => {
  function concurrentFixture(): {
    readonly value: XProvider;
    readonly started: Deferred;
    readonly release: Deferred;
    tokenRequests(): number;
  } {
    const started = new Deferred();
    const release = new Deferred();
    let tokenRequests = 0;
    let postId = 0;
    const store = new MemoryTokenStore({
      accessToken: "expired",
      refreshToken: "refresh-old",
      expiresAt: now + 1,
    });
    const http: HttpClient = {
      request: async <T>(request: HttpRequest): Promise<HttpResponse<T>> => {
        if (request.url.endsWith("/oauth/token")) {
          tokenRequests += 1;
          started.resolve();
          await release.promise;
          return {
            status: 200,
            headers: okHeaders,
            data: {
              access_token: "access-new",
              refresh_token: "refresh-new",
              expires_in: 3_600,
              token_type: "Bearer",
            },
          } as HttpResponse<T>;
        }
        postId += 1;
        return {
          status: 201,
          headers: okHeaders,
          data: { data: { id: String(postId), text: "shared" } },
        } as HttpResponse<T>;
      },
    };
    return {
      started,
      release,
      tokenRequests: () => tokenRequests,
      value: new XProvider({
        http,
        tokenStore: store,
        clock: { now: () => now },
        sleep: async () => undefined,
        clientId: "client-id",
        apiBaseUrl: "https://x.test",
        oauthTokenUrl: "https://x.test/oauth/token",
      }),
    };
  }

  it("does not let an aborted refresh leader cancel an un-aborted follower", async () => {
    const fixture = concurrentFixture();
    const leaderController = new AbortController();
    const leaderReason = new Error("leader aborted");
    const leader = fixture.value.publish({ text: "shared", signal: leaderController.signal });
    await fixture.started.promise;
    const follower = fixture.value.publish({ text: "shared" });
    await Promise.resolve();
    leaderController.abort(leaderReason);
    fixture.release.resolve();

    await assert.rejects(leader, (error: unknown) => error === leaderReason);
    assert.equal((await follower).text, "shared");
    assert.equal(fixture.tokenRequests(), 1);
  });

  it("rejects an aborted follower promptly without cancelling the shared refresh", async () => {
    const fixture = concurrentFixture();
    const leader = fixture.value.publish({ text: "shared" });
    await fixture.started.promise;
    const followerController = new AbortController();
    const followerReason = new Error("follower aborted");
    const follower = fixture.value.publish({ text: "shared", signal: followerController.signal });
    await Promise.resolve();
    followerController.abort(followerReason);

    await assert.rejects(follower, (error: unknown) => error === followerReason);
    assert.equal(fixture.tokenRequests(), 1);
    fixture.release.resolve();
    assert.equal((await leader).text, "shared");
  });
});
