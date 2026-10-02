# Task 68 — full-stack-developer

## Task
Implement the `connectQwen` function in `src/app/page.tsx` using the Aliyun RTC SDK (`aliyun-rtc-sdk@7.3.7`). Replace the Task 67 "coming soon" stub with the full integration: dynamic import → joinChannel → publish local mic → subscribe to remote AI audio → handle OpenAI Realtime API events on the data channel → teardown on disconnect.

## What I changed
- `src/app/page.tsx` (+427 / -41 lines):
  - Added `qwenEngineRef = useRef<any>(null)` at line 217 (after `inworldWsRef`).
  - Updated `teardown` (lines 296-310) to also destroy the Qwen engine: `engine.publishLocalAudioStream(false)` + `engine.leaveChannel()` + `engine.destroy()` (fire-and-forget with `.catch(() => {})`).
  - Replaced `connectQwen` (was ~85 lines stub, now ~420 lines full implementation) with the full Aliyun RTC SDK flow: GET /api/qwen/token health-check → POST /api/qwen/token with minimal `v=0` SDP → dynamic `import("aliyun-rtc-sdk")` → `AliRtcEngine.createInstance()` → `engine.joinChannel(authInfo, "rtc-user-client")` → `engine.publishLocalAudioStream(true)` → `engine.subscribeAllRemoteAudioStreams(true)` → listen for `remoteTrackAvailableNotify` + `getAudioTrack` + play via `audioElRef` → listen for `dataChannelMsg` events (session.created sends a session.update with voice Tina + server_vad 800ms; speech_started calls clearAudioQueue + resets inUserSpeechRef; user transcripts via upsertUserLine; AI transcripts via local appendAiDelta; errors logged).
  - Updated `toggleMute` (lines 1888-1907) to call `engine.muteLocalMic(next)` if `qwenEngineRef.current` is set (the Aliyun SDK owns the mic stream — `localStreamRef.current` is null for Qwen). Falls through to the existing path for ChatGPT/Perplexity/Gemini/Inworld.
- `package.json` (+1 line: `"aliyun-rtc-sdk": "^7.3.7"`) — already in working tree, committed as part of this task.
- `bun.lock` (lockfile update for the SDK + transitive deps).
- `worklog.md` (appended Task 68 entry — 106 lines).

## Verification
- `bun run lint` → 0 errors / 0 warnings (exit code 0).
- Local dev: `GET http://localhost:3000/` → HTTP 200, page contains "Qwen" + "aliyun" markers. Dev-mode Turbopack splits the SDK into a separate chunk (`node_modules_aliyun-rtc-sdk_dist_aliyun-rtc-sdk_es_1eb3cee6.js`, 761-byte loader → 1.65 MB SDK chunk).
- Vercel auto-deploy: `GET https://ace-studio-orcin.vercel.app/` → HTTP 200, 36 KB, 0.81s.
- Production page chunk `bcb19578ea011d22.js` (357 KB) contains all connectQwen markers:
  - `aliyun-rtc-sdk` × 3, `joinChannel` × 1, `rtc_token` × 2, `createInstance` × 2, `publishLocalAudioStream` × 2, `subscribeAllRemoteAudioStreams` × 1, `getAudioTrack` × 2, `leaveChannel` × 1, `sendDataChannelMessage` × 1, `dataChannelMsg` × 1, `remoteTrackAvailableNotify` × 1, `muteLocalMic` × 1, `session.update` × 7, `Aliyun RTC` × 8.
  - `AliRtcEngine` × 0 in the main chunk (expected — the dynamic import's default export is bound to a minified variable).
- Aliyun RTC SDK is in a separate dynamically-loaded chunk `08f439290b3e0050.js` (1.04 MB) — confirmed by following the Turbopack loader chain: `d961c819d839f83d.js` (218 bytes, loader) → `08f439290b3e0050.js` (1.04 MB, the SDK). The SDK chunk contains `AliRtcEngine` × 5 + all the SDK API methods.
- Task's exact verification command: `grep -c "aliyun-rtc-sdk\|AliRtcEngine\|joinChannel\|rtc_token" /tmp/chunk68.js` → `1` (the chunk contains the markers on one minified line).

## Commits
- `957c7cf` — `feat(qwen): integrate Aliyun RTC SDK for Qwen Voice — joinChannel + audio publish/subscribe + OpenAI Realtime API event handling` (3 files, +534 / -41).
- `53da3e2` — `docs(worklog): append Task 68 — Aliyun RTC SDK integration for Qwen Voice` (1 file, +106).
- Pushed: `f6a24a0..53da3e2 main -> main`.

## Follow-ups
1. Live end-to-end test with a fresh token — the implementation is verified to compile + deploy, but the actual voice call requires a fresh `QWEN_ACCESS_TOKEN` JWT (the previous one is expired + the backend can't auto-refresh due to IP-bound `acw_tc` cookie).
2. Token auto-refresh Chrome extension (same as Task 65 follow-up).
3. Voice selection (currently hardcoded "Tina" — same as Task 64 follow-up).
4. Settings UI for Qwen token (same as Task 65 follow-up).

## Key files referenced (for next agents)
- `/home/z/my-project/src/app/page.tsx` — the `connectQwen` function (lines 1440-1859), `qwenEngineRef` ref (line 217), `teardown` Qwen cleanup (lines 296-310), `toggleMute` Qwen branch (lines 1888-1907).
- `/home/z/my-project/src/app/api/qwen/token/route.ts` — the backend route (unchanged from Tasks 64-66).
- `/home/z/my-project/node_modules/aliyun-rtc-sdk/dist/types/index.d.ts` — the SDK TypeScript types (7288 lines).
