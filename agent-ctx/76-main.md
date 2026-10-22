# Task ID 76 — main (Z.ai Code)

## Task
Add the TEN Agent (theten.ai) as the 8th realtime voice provider in `src/app/page.tsx` — Agora RTC + OpenAI voice assistant (graph `va_openai_v2v`).

## What was already in place (verified, committed in this task)
- `RealtimeProvider` type at `src/app/page.tsx:168` already includes `"ten"` (pre-existing).
- Backend route `POST /api/ten/token` (`src/app/api/ten/token/route.ts`) — was functional but untracked; this task committed it. Proxies to `https://agent.theten.ai/api/token/generate` → returns `{ ok, appId, token, channel, uid }`.
- `agora-rtc-sdk-ng` v4.24.9 in `package.json` (line 52) — also committed in this task.

## What I changed
- `src/app/page.tsx` (+324 / -10 across 8 modifications):
  1. **Refs** (after `voskAudioElRef` at line 292): `tenClientRef = useRef<any>(null)` (AgoraRTC client), `tenAudioTrackRef = useRef<any>(null)` (local mic audio track), `tenRemoteAudioRef = useRef<HTMLAudioElement | null>(null)` (hidden audio element playing AI's remote audio). Detailed comment block.
  2. **teardown**: new TEN block after the Vosk block, before the shared mic cleanup. Calls `client.leave()` (fire-and-forget) + `audioTrack.close()` + `pause()`/`null` on the hidden audio element. Defensive `client.removeAllListeners()`. Clearing refs first = duplicate teardown no-op.
  3. **connectTen** (new `useCallback`, ~195 lines, before `connect`): full flow:
     1. `POST /api/ten/token {}` → `{ ok, appId, token, channel, uid }` (15s timeout).
     2. Dynamic `import("agora-rtc-sdk-ng")` — browser-only SDK, must NOT be imported at module top-level.
     3. `AgoraRTC.createClient({ mode: "rtc", codec: "vp8" })` → `client.join(appId, channel, token, uid)`.
     4. `AgoraRTC.createMicrophoneAudioTrack()` → store in `tenAudioTrackRef` + derive a `MediaStream` from the underlying `MediaStreamTrack` for `localStreamRef` so the existing `toggleMute` works.
     5. `client.publish([audioTrack])` → publishes mic audio to the channel.
     6. `client.on("user-published", ...)` → subscribe to the AI's audio track + play via a hidden `<audio>` element (`tenRemoteAudioRef`).
     7. `client.on("stream-message", ...)` → decode binary `Uint8Array` with `TextDecoder` + JSON.parse, dispatch on `msg.type` / `msg.role` (user transcript → `upsertUserLine`; AI response → append to AI: line). Normalizes `text`/`transcript`/`delta` field names.
     8. `POST https://agent.theten.ai/api/agents/start` with `graph_name: "va_openai_v2v"`, `language: "en-US"`, `voice_type: "male"` — fire-and-forget, non-fatal on failure.
  4. **connect dispatcher**: added `else if (providerRef.current === "ten") { await connectTen(); }` branch + added `connectTen` to the `useCallback` deps array (alphabetical order: `connectGemini, connectInworld, connectQwen, connectTen, connectVosk, connectWebRtc, connectZai`). Updated JSDoc comment.
  5. **toggleMute JSDoc**: added a TEN sentence + updated the inline comment to include "/ TEN" in the shared `localStreamRef` path.
  6. **disconnect JSDoc**: added a TEN sentence ("for TEN the `client.leave()` inside `teardown` IS the stop").
  7. **CardDescription**: added a TEN sentence + updated the auth-requirements sentence ("TEN needs nothing — the backend route proxies to agent.theten.ai which issues the Agora token + starts the agent").
  8. **ProviderButton**: added a "TEN" provider button (8th in the row, after Vosk).
- `src/app/api/ten/token/route.ts` (committed in this task — was untracked): the TEN token route that proxies to agent.theten.ai.
- `package.json` (+1 line: `"agora-rtc-sdk-ng": "^4.24.9"` — was already in the working tree, committed in this task).

## Verification
- `bun run lint` → 0 errors / 0 warnings (exit code 0).
- Dev server log: `POST /api/ten/token 200 in 1115ms` (the endpoint works + returns valid Agora credentials — verified by `curl -X POST http://localhost:3000/api/ten/token -d "{}"` → 200 with appId `b8d13d3e1ed74347b21ec75d170e87ea`, channel `ten-1792692378598`, uid 741947, token `007eJxSYNhfO...`).
- Page compiles + serves successfully (`GET / 200` in ~15-75ms).
- All TEN markers verified present in the file: `tenClientRef` × 4, `tenAudioTrackRef` × 3, `tenRemoteAudioRef` × 6, `connectTen` × 4, `provider === "ten"` × 1, `va_openai_v2v` × 2, `agora-rtc-sdk-ng` × 2, `user-published` × 1, `stream-message` × 1, `createMicrophoneAudioTrack` × 1, `client.publish` × 1, `client.subscribe` × 1, `client.leave` × 2, `audioTrack.close` × 1.

## Commits
- `431f8fe` — `feat: add TEN Agent (theten.ai) as 8th realtime voice provider — Agora RTC + OpenAI voice assistant` (3 files, +398 / -10).
- Pushed: `d51eac1..431f8fe main -> main`.

## Follow-ups
1. **Live end-to-end test** — verified to compile + lint clean + the `/api/ten/token` endpoint returns valid credentials. The actual voice call requires a real Agora channel + the OpenAI voice assistant graph to be reachable from `agent.theten.ai/api/agents/start` (may require a TEN account / API key — the current implementation uses the public endpoint).
2. **Graph selection UI** — v1 hardcodes `va_openai_v2v` (OpenAI voice assistant). A dropdown to select other graphs (`va_elevenlabs_v2v`, `va_coqui_v2v`, etc.) would be a nice addition.
3. **Language + voice selection** — v1 hardcodes `language: "en-US"` + `voice_type: "male"`. Dropdowns for language + voice type would be nice.
4. **Barge-in** — v1 has no explicit client-side barge-in (the OpenAI voice assistant graph has server-side VAD + auto-interrupts). Could implement by listening for a "speech_started" message + pausing the hidden audio element.
5. **Token caching** — v1 fetches a fresh Agora token on every Connect. Could cache in `localStorage` with a TTL based on the Agora token expiry (typically 24h).

## Key files referenced (for next agents)
- `/home/z/my-project/src/app/page.tsx` — `connectTen` function (lines 2671-2921), the TEN refs (lines 293-309), `teardown` TEN block (lines 452-475), `connect` dispatcher TEN branch (line 2946-2947), `connect` deps array (line 2958), `toggleMute` TEN JSDoc (lines 2960-2970), `toggleMute` shared path comment (line 3004), `disconnect` TEN JSDoc (line 3017), `CardDescription` TEN sentence (lines 3080-3090), `ProviderButton` TEN (lines 3153-3159).
- `/home/z/my-project/src/app/api/ten/token/route.ts` — the backend route (74 lines, proxies to agent.theten.ai → astra-agents-api.agora.io).
- `/home/z/my-project/node_modules/agora-rtc-sdk-ng/` — the SDK (esm entry: `AgoraRTC_N-production.esm.mjs`, types: `rtc-sdk_en.d.ts`).
- `/home/z/my-project/package.json` — `agora-rtc-sdk-ng` v4.24.9 at line 52.
