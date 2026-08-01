import type { SocialProvider, SocialPlatform } from "./social-provider.js";

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const MAX_POST_TEXT_LENGTH = 280;

export const publishPostTool = {
  name: "publish_post",
  description: "Publish a social post, or reply to an existing post when replyToId is supplied.",
  inputSchema: {
    type: "object",
    properties: {
      platform: { type: "string", enum: ["x"] },
      text: { type: "string", minLength: 1, maxLength: MAX_POST_TEXT_LENGTH },
      replyToId: { type: "string", minLength: 1 },
    },
    required: ["platform", "text"],
    additionalProperties: false,
  },
} as const satisfies McpTool;

export const getAnalyticsTool = {
  name: "get_analytics",
  description: "Get normalized analytics for one social post.",
  inputSchema: {
    type: "object",
    properties: {
      platform: { type: "string", enum: ["x"] },
      postId: { type: "string", minLength: 1 },
    },
    required: ["platform", "postId"],
    additionalProperties: false,
  },
} as const satisfies McpTool;

export const socialTools = [publishPostTool, getAnalyticsTool] as const;

export type ProviderRegistry = Readonly<Record<SocialPlatform, SocialProvider>>;

export interface ToolTextContent {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly isError?: boolean;
}

export type ToolHandler = (arguments_: unknown, signal?: AbortSignal) => Promise<ToolTextContent>;

export interface SocialToolHandlers {
  readonly publish_post: ToolHandler;
  readonly get_analytics: ToolHandler;
}

export function createSocialToolHandlers(providers: ProviderRegistry): SocialToolHandlers {
  return {
    publish_post: async (arguments_: unknown, signal?: AbortSignal): Promise<ToolTextContent> => {
      const input = publishArguments(arguments_);
      const provider = providers[input.platform];
      const result = input.replyToId === undefined
        ? await provider.publish({ text: input.text, ...(signal === undefined ? {} : { signal }) })
        : await provider.reply({
          postId: input.replyToId,
          text: input.text,
          ...(signal === undefined ? {} : { signal }),
        });
      return textResult(result);
    },
    get_analytics: async (arguments_: unknown, signal?: AbortSignal): Promise<ToolTextContent> => {
      const input = analyticsArguments(arguments_);
      const result = await providers[input.platform].analytics({
        postId: input.postId,
        ...(signal === undefined ? {} : { signal }),
      });
      return textResult(result);
    },
  };
}

interface PublishArguments {
  readonly platform: SocialPlatform;
  readonly text: string;
  readonly replyToId?: string;
}

interface AnalyticsArguments {
  readonly platform: SocialPlatform;
  readonly postId: string;
}

function publishArguments(value: unknown): PublishArguments {
  const object = strictObject(value, ["platform", "text", "replyToId"]);
  const platform = platformValue(object["platform"]);
  const text = boundedText(object["text"]);
  const replyToId = object["replyToId"];
  return replyToId === undefined
    ? { platform, text }
    : { platform, text, replyToId: nonEmptyString(replyToId, "replyToId") };
}

function analyticsArguments(value: unknown): AnalyticsArguments {
  const object = strictObject(value, ["platform", "postId"]);
  return {
    platform: platformValue(object["platform"]),
    postId: nonEmptyString(object["postId"], "postId"),
  };
}

function strictObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tool arguments must be an object");
  }
  const object = value as Record<string, unknown>;
  const unexpected = Object.keys(object).find((key) => !allowedKeys.includes(key));
  if (unexpected !== undefined) throw new TypeError(`Unexpected tool argument: ${unexpected}`);
  return object;
}

function platformValue(value: unknown): SocialPlatform {
  if (value !== "x") throw new TypeError("platform must be x");
  return value;
}

function boundedText(value: unknown): string {
  const text = nonEmptyString(value, "text");
  if (Array.from(text).length > MAX_POST_TEXT_LENGTH) {
    throw new TypeError(`text must contain at most ${MAX_POST_TEXT_LENGTH} characters`);
  }
  return text;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function textResult(value: unknown): ToolTextContent {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
