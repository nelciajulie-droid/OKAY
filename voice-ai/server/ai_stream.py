#!/usr/bin/env python3
"""
NVIDIA Nemotron streaming — outputs text tokens to stdout as they arrive.
Called by server.js as: python3 ai_stream.py "<user text>"
Each token is flushed immediately so Node.js can detect sentence boundaries.
"""

import sys
import os

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

os.environ["NVIDIA_API_KEY"] = api_key

# --- NVIDIA streaming ---
try:
    from langchain_nvidia_ai_endpoints import ChatNVIDIA
except ImportError:
    sys.stderr.write("langchain-nvidia-ai-endpoints not installed. Run: pip install langchain-nvidia-ai-endpoints\n")
    sys.exit(1)

user_text = " ".join(sys.argv[1:])
if not user_text:
    sys.exit(0)

client = ChatNVIDIA(
    model="nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    api_key=api_key,
    temperature=0.2,
    top_p=0.95,
    max_completion_tokens=10000,
)

# Stream the response — each chunk is flushed to stdout immediately.
# The Node.js server accumulates these + detects sentence boundaries.
messages = [
    {"role": "system", "content": "You are a helpful voice assistant. Keep responses concise and conversational. Respond in the same language as the user."},
    {"role": "user", "content": user_text},
]

try:
    for chunk in client.stream(messages, chat_template_kwargs={"enable_thinking": False}):
        text = chunk.content if hasattr(chunk, "content") else str(chunk)
        if text:
            sys.stdout.write(text)
            sys.stdout.flush()
except Exception as e:
    sys.stderr.write(f"NVIDIA streaming error: {e}\n")
    sys.exit(1)
