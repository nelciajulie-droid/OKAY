#!/usr/bin/env python3
"""
NVIDIA Nemotron streaming — outputs text tokens to stdout as they arrive.
Called by server.js as: python3 ai_stream.py "<user text>"
Each token is flushed immediately so Node.js can detect sentence boundaries.

Uses raw HTTP requests (not langchain) for maximum compatibility + streaming.
"""

import sys
import os
import requests
import json

# --- NVIDIA API key ---
api_key = os.environ.get("NVIDIA_API_KEY", "")
if not api_key:
    # Fallback: try to read from .env file
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("NVIDIA_API_KEY="):
                    api_key = line.split("=", 1)[1].strip()
                    break

if not api_key:
    sys.stderr.write("NVIDIA_API_KEY not set. Get one at https://build.nvidia.com\n")
    sys.exit(1)

user_text = " ".join(sys.argv[1:])
if not user_text:
    sys.exit(0)

# --- NVIDIA streaming via raw HTTP requests ---
# The model nvidia/nemotron-3-nano-omni-30b-a3b-reasoning works with this API.
MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
API_URL = "https://integrate.api.nvidia.com/v1/chat/completions"

messages = [
    {"role": "system", "content": "You are a helpful voice assistant. Keep responses concise and conversational. Respond in the same language as the user."},
    {"role": "user", "content": user_text},
]

try:
    response = requests.post(
        API_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "messages": messages,
            "max_tokens": 200,
            "temperature": 0.2,
            "top_p": 0.95,
            "stream": True,
        },
        stream=True,
        timeout=30,
    )

    if response.status_code != 200:
        sys.stderr.write(f"NVIDIA API returned {response.status_code}: {response.text[:200]}\n")
        sys.exit(1)

    for line in response.iter_lines():
        if not line:
            continue
        line = line.decode("utf-8")
        if line.startswith("data: "):
            data = line[6:]
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
                delta = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                if delta:
                    sys.stdout.write(delta)
                    sys.stdout.flush()
            except json.JSONDecodeError:
                continue

except Exception as e:
    sys.stderr.write(f"NVIDIA streaming error: {e}\n")
    sys.exit(1)
