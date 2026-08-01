export type SocialPlatform = "x";

export interface PublishInput {
  readonly text: string;
  readonly signal?: AbortSignal;
}

export interface ReplyInput extends PublishInput {
  readonly postId: string;
}

export interface AnalyticsInput {
  readonly postId: string;
  readonly signal?: AbortSignal;
}

export interface PublishedPost {
  readonly platform: SocialPlatform;
  readonly postId: string;
  readonly text: string;
  readonly url: string;
}

export interface PostAnalytics {
  readonly platform: SocialPlatform;
  readonly postId: string;
  readonly createdAt?: string;
  readonly metrics: {
    readonly likes: number;
    readonly replies: number;
    readonly reposts: number;
    readonly quotes: number;
    readonly impressions: number;
    readonly bookmarks: number;
  };
}

/** Every platform adapter must implement this exact normalized contract. */
export abstract class SocialProvider {
  public abstract publish(input: PublishInput): Promise<PublishedPost>;
  public abstract reply(input: ReplyInput): Promise<PublishedPost>;
  public abstract analytics(input: AnalyticsInput): Promise<PostAnalytics>;
}
