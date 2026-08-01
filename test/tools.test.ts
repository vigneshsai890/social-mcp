import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SocialProvider } from "../src/social-provider.js";
import { createSocialToolHandlers, getAnalyticsTool, publishPostTool } from "../src/tools.js";

class RecordingProvider extends SocialProvider {
  public readonly calls: string[] = [];

  public override async publish(input: { readonly text: string }) {
    this.calls.push(`publish:${input.text}`);
    return { platform: "x" as const, postId: "1", text: input.text, url: "https://x.com/i/web/status/1" };
  }

  public override async reply(input: { readonly postId: string; readonly text: string }) {
    this.calls.push(`reply:${input.postId}:${input.text}`);
    return { platform: "x" as const, postId: "2", text: input.text, url: "https://x.com/i/web/status/2" };
  }

  public override async analytics(input: { readonly postId: string }) {
    this.calls.push(`analytics:${input.postId}`);
    return {
      platform: "x" as const,
      postId: input.postId,
      metrics: { likes: 1, replies: 0, reposts: 0, quotes: 0, impressions: 2, bookmarks: 0 },
    };
  }
}

describe("social MCP tools", () => {
  it("exports strict JSON Schema tool objects", () => {
    assert.equal(publishPostTool.name, "publish_post");
    assert.equal(publishPostTool.inputSchema.type, "object");
    assert.equal(publishPostTool.inputSchema.additionalProperties, false);
    assert.deepEqual(publishPostTool.inputSchema.required, ["platform", "text"]);
    assert.equal(publishPostTool.inputSchema.properties.text.maxLength, 280);
    assert.equal(getAnalyticsTool.name, "get_analytics");
    assert.deepEqual(getAnalyticsTool.inputSchema.required, ["platform", "postId"]);
  });

  it("maps handlers to publish, reply, and analytics", async () => {
    const provider = new RecordingProvider();
    const handlers = createSocialToolHandlers({ x: provider });
    await handlers.publish_post({ platform: "x", text: "one" });
    await handlers.publish_post({ platform: "x", text: "two", replyToId: "1" });
    const result = await handlers.get_analytics({ platform: "x", postId: "2" });

    assert.deepEqual(provider.calls, ["publish:one", "reply:1:two", "analytics:2"]);
    assert.equal(JSON.parse(result.content[0].text).metrics.impressions, 2);
  });

  it("rejects extra properties at runtime consistently with the schemas", async () => {
    const handlers = createSocialToolHandlers({ x: new RecordingProvider() });
    await assert.rejects(
      handlers.publish_post({ platform: "x", text: "one", unexpected: true }),
      /Unexpected tool argument/,
    );
  });
});


describe("post text length", () => {
  it("rejects text longer than the schema maximum at runtime", async () => {
    const handlers = createSocialToolHandlers({ x: new RecordingProvider() });
    await assert.rejects(
      handlers.publish_post({ platform: "x", text: "x".repeat(281) }),
      /at most 280 characters/,
    );
  });
});


describe("Unicode post text length", () => {
  it("accepts 280 Unicode code points as allowed by JSON Schema maxLength", async () => {
    const provider = new RecordingProvider();
    const handlers = createSocialToolHandlers({ x: provider });
    await handlers.publish_post({ platform: "x", text: "😀".repeat(280) });
    assert.equal(provider.calls.length, 1);
  });
});
