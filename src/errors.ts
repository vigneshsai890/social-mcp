import type { SocialPlatform } from "./social-provider.js";

export type SocialErrorCode =
  | "AUTHENTICATION_ERROR"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "API_ERROR"
  | "INVALID_RESPONSE"
  | "CONFIGURATION_ERROR";

export interface SocialProviderErrorOptions {
  readonly platform: SocialPlatform;
  readonly operation: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/** A deliberately allow-listed error shape: request data, credentials, responses, and raw causes are never retained. */
export class SocialProviderError extends Error {
  public readonly code: SocialErrorCode;
  public readonly platform: SocialPlatform;
  public readonly operation: string;
  public readonly status: number | undefined;
  public readonly retryable: boolean;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(code: SocialErrorCode, message: string, options: SocialProviderErrorOptions) {
    super(message);
    this.name = "SocialProviderError";
    this.code = code;
    this.platform = options.platform;
    this.operation = options.operation;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    const value: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      message: this.message,
      platform: this.platform,
      operation: this.operation,
      retryable: this.retryable,
    };
    if (this.status !== undefined) value["status"] = this.status;
    if (this.details !== undefined) value["details"] = this.details;
    return value;
  }
}
