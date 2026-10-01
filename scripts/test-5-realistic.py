#!/usr/bin/env python3
"""
Realistic test: 5 generations with 15s delay between each. Simulates normal
usage (not a stress test). This avoids triggering boppy's burst limit and
gives the proxy-chain pool + retry logic a fair chance to succeed.
"""
import json
import time
import urllib.request
import urllib.error

APP = "http://localhost:3000"
N = 5
DELAY_S = 15

PROMPTS = [
    "A dreamy lo-fi beat about rain on a window in Tokyo",
    "A short happy ukulele tune about sunshine",
    "An upbeat synthwave track for a neon night drive",
    "A melancholy piano piece about autumn leaves",
    "A funky bass-driven groove for a sunny morning",
]

def post_json(path, payload, timeout=120):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{APP}{path}", data=data, method="POST",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"error": body}
    except Exception as e:
        return 0, {"error": str(e)}

def get_json(path, timeout=30):
    try:
        with urllib.request.urlopen(f"{APP}{path}", timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return 0, {"error": str(e)}

def poll_track(track_id, max_attempts=12, interval=4):
    for i in range(1, max_attempts + 1):
        status, body = get_json("/api/tracks", timeout=15)
        if status != 200:
            time.sleep(interval)
            continue
        tracks = body.get("tracks", []) if isinstance(body, dict) else []
        match = next((t for t in tracks if t.get("id") == track_id), None)
        if not match:
            time.sleep(interval)
            continue
        s = match.get("status")
        if s in ("SUCCESS", "FAILED", "ERROR", "TIMEOUT"):
            return s, match
        time.sleep(interval)
    return "TIMEOUT_POLL", None

print(f"=== REALISTIC TEST: {N} generations × {DELAY_S}s delay ===")
print()
print(f"{'#':>3} {'prompt':48} {'compose':>8} {'gen':>6} {'poll':>10} {'mp3?':>5}")
print("-" * 90)

results = []
start = time.time()

for i in range(N):
    prompt = PROMPTS[i]
    print(f"{i+1:>3} {prompt[:48]:48}", end="", flush=True)
    row = {"index": i + 1, "prompt": prompt}

    t0 = time.time()
    code, body = post_json("/api/lyrics", {"prompt": prompt}, timeout=120)
    row["compose_status"] = code
    if code != 200 or not body.get("title"):
        err_msg = str(body.get("error", ""))[:60] if isinstance(body, dict) else ""
        print(f" {code:>8}  FAIL    FAIL    n/a   | {err_msg}")
        row["error"] = f"compose failed: {err_msg}"
        results.append(row)
        time.sleep(DELAY_S)
        continue
    title = body.get("title") or prompt
    caption = body.get("caption") or prompt
    row["title"] = title
    compose_ms = int((time.time() - t0) * 1000)

    t0 = time.time()
    payload = {"prompt": prompt, "styleTags": caption, "title": title, "duration": 30, "bpm": 120}
    code, body = post_json("/api/generate", payload, timeout=120)
    row["generate_status"] = code
    if code not in (200, 201) or not isinstance(body, dict) or "generation" not in body:
        msg = ""
        if isinstance(body, dict):
            err = str(body.get("error", ""))[:50]
            retry_after = body.get("retryAfter")
            kind = body.get("kind")
            msg = err
            if retry_after:
                msg += f" retryAfter={retry_after}s kind={kind}"
        print(f" {compose_ms:>7}ms  {code:>4}    FAIL    n/a   | {msg}")
        row["error"] = f"generate failed: {msg}"
        results.append(row)
        time.sleep(DELAY_S)
        continue

    track = body["generation"]["tracks"][0]
    track_id = track["id"]
    row["track_id"] = track_id
    gen_ms = int((time.time() - t0) * 1000)

    t0 = time.time()
    status, track_obj = poll_track(track_id, max_attempts=12, interval=4)
    poll_ms = int((time.time() - t0) * 1000)
    row["final_status"] = status

    if status == "SUCCESS":
        song_path = track_obj.get("songPath") if track_obj else None
        has_mp3 = bool(song_path and "mp3" in song_path.lower())
        mp3_check = "OK" if has_mp3 else "?"
        print(f" {compose_ms:>7}ms  {gen_ms:>5}ms  {status:>10} {mp3_check:>5}")
    else:
        print(f" {compose_ms:>7}ms  {gen_ms:>5}ms  {status:>10}    n/a")

    results.append(row)
    if i < N - 1:
        print(f"     (waiting {DELAY_S}s to avoid boppy burst)")
        time.sleep(DELAY_S)

total_s = int(time.time() - start)
print()
print(f"=== SUMMARY ===")
print(f"Total time: {total_s}s ({total_s/60:.1f} min)")
success = [r for r in results if r.get("final_status") == "SUCCESS"]
failed = [r for r in results if r.get("final_status") != "SUCCESS"]
print(f"SUCCESS: {len(success)} / {len(results)}")
print(f"FAILED:  {len(failed)} / {len(results)}")
if failed:
    print("\nFailures:")
    for r in failed:
        print(f"  #{r['index']}: {r.get('error', r.get('final_status', 'unknown'))}")
