# Deploying tty-bot

Goal: an agent you reach like a server, not a chat app — a WebSocket endpoint that speaks the REPL's JSON frames, powered by Gemini through the native `gemini` provider. Budget ~5 minutes.

Two things are demonstrated here and nothing else: the `tty` trigger (the REPL as a network surface, for hosted terminals) and the `gemini` provider. There is no permissions block, so the agent holds no shell, filesystem, or network — the terminal is the whole surface.

## What you need before starting

- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## 1. Run it

```sh
export GEMINI_API_KEY=AIza... TTY_TOKEN=$(openssl rand -hex 24)
af run examples/tty-bot/agent.yaml
```

The trigger listens on port 8090 and accepts a WebSocket upgrade at `/tty`. The token is required: an unauthenticated terminal contradicts deny-by-default.

## 2. Connect

The wire format is JSON frames: send `{"type": "input", "text": "..."}`, receive the run's progress and result as frames. With [websocat](https://github.com/vi/websocat):

```sh
websocat ws://localhost:8090/tty -H "authorization: Bearer $TTY_TOKEN"
{"type": "input", "text": "what time is it?"}
```

Browsers cannot set an authorization header on a WebSocket, so pass the token as the subprotocol instead:

```js
const ws = new WebSocket("ws://localhost:8090/tty", [`bearer.${token}`]);
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.send(JSON.stringify({ type: "input", text: "what time is it?" }));
```

One run at a time per connection; `{"type": "cancel"}` is the one frame allowed through mid-run and aborts it.

## Notes

- `gemini` is the native Gemini API dialect (`generateContent`). `GEMINI_API_KEY` is its default key env; set `model.api_key_env` to read a different var, or `model.base_url` to point at a proxy.
- In hermetic deployments the provider's egress host `generativelanguage.googleapis.com` is allowlisted automatically.
