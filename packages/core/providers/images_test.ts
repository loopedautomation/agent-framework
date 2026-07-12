import { assert, assertEquals } from "@std/assert";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAICompatibleProvider } from "./openai.ts";
import type { ImageContent, Message } from "./types.ts";

const IMAGE: ImageContent = { mediaType: "image/png", data: "aGVsbG8=" };

/** Captures the request body a provider would send, and answers with a valid empty reply. */
function capture(reply: unknown): { fetch: typeof fetch; body: () => Record<string, unknown> } {
  let sent: Record<string, unknown> = {};
  const fake: typeof fetch = (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: fake, body: () => sent };
}

const ANTHROPIC_REPLY = {
  content: [{ type: "text", text: "a cat" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const OPENAI_REPLY = {
  choices: [{ message: { content: "a cat" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

Deno.test("images/anthropic sends the image as a content block before the text", async () => {
  const { fetch, body } = capture(ANTHROPIC_REPLY);
  const provider = new AnthropicProvider({ apiKey: "k", fetch });
  const messages: Message[] = [{ role: "user", content: "what is this?", images: [IMAGE] }];
  await provider.complete({ model: "claude-sonnet-5", messages });

  const wire = body().messages as { role: string; content: Record<string, unknown>[] }[];
  assertEquals(wire[0].content.length, 2);
  assertEquals(wire[0].content[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
  });
  // Text last: the model reads the question as being about what it was just shown.
  assertEquals(wire[0].content[1], { type: "text", text: "what is this?" });
});

Deno.test("images/openai sends the array form only when there is an image", async () => {
  const { fetch, body } = capture(OPENAI_REPLY);
  const provider = new OpenAICompatibleProvider({ apiKey: "k", fetch });

  await provider.complete({
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: "what is this?", images: [IMAGE] }],
  });
  const withImage = (body().messages as { role: string; content: unknown }[]).at(-1)!;
  const parts = withImage.content as Record<string, unknown>[];
  assert(Array.isArray(parts));
  assertEquals(parts[0], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,aGVsbG8=" },
  });

  await provider.complete({
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: "no image here" }],
  });
  const plain = (body().messages as { role: string; content: unknown }[]).at(-1)!;
  // A bare string, still: an agent with no images must never discover whether
  // the proxy in front of it implemented the array form.
  assertEquals(plain.content, "no image here");
});
