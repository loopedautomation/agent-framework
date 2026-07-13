// The mock model backend for the action smoke test: a fake openai-compatible
// /chat/completions that exercises the whole loop — the first-boot naming
// call gets a plain name, a tool result gets the final text, anything else
// gets a current_time tool call (a native tool that is always available).
Deno.serve({ hostname: "0.0.0.0", port: 8734 }, async (req) => {
  const url = new URL(req.url);
  if (!url.pathname.endsWith("/chat/completions")) {
    return new Response("not found", { status: 404 });
  }
  const body = await req.json();
  const last = (body.messages as { role: string }[]).at(-1);
  let message: Record<string, unknown>;
  if (!body.tools) {
    message = { role: "assistant", content: "Smokey" };
  } else if (last?.role === "tool") {
    message = { role: "assistant", content: "The current time is 12:00 UTC." };
  } else {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "current_time", arguments: "{}" },
      }],
    };
  }
  return Response.json({
    choices: [{ message, finish_reason: body.tools ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
});
