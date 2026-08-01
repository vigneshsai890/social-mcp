export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly data: T;
}

/** Implementations return all HTTP statuses as responses and throw only for transport failures. */
export interface HttpClient {
  request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Unix epoch milliseconds. */
  readonly expiresAt: number;
}

export interface TokenStore {
  load(): Promise<OAuthTokens>;
  save(tokens: OAuthTokens): Promise<void>;
}

export interface Clock {
  now(): number;
}

export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
