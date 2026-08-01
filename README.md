# social-mcp

A strict TypeScript starter for MCP social tools. It provides a normalized `SocialProvider` contract, exact MCP-compatible tool definitions, and an X API v2 adapter.

## API

- `publish_post`: calls `publish()`, or `reply()` when `replyToId` is present.
- `get_analytics`: calls `analytics()`.
- `XProvider`: maps those operations to X v2 `POST /2/tweets` and `GET /2/tweets/:id`.

Register `socialTools` with an MCP server and dispatch tool calls through `createSocialToolHandlers({ x: provider })`.

## X adapter guarantees

All side effects are injected: `HttpClient`, `TokenStore`, `Clock`, and `Sleep`. The provider refreshes OAuth tokens before expiry, performs at most one additional refresh after a 401, and transparently retries 429 responses within configured count and delay bounds. It honors both `retry-after` and `x-rate-limit-reset`, choosing the later deadline.

Errors use the allow-listed `SocialProviderError` shape. The provider has no logger and never places credentials, authorization headers, token request bodies, or raw responses in errors. A production `HttpClient` must apply the same redaction policy.

## Commands

Dependencies are exact-pinned. After an intentional install by the consumer:

```sh
npm run check
npm test
```
