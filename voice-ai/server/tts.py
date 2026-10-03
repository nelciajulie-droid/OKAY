"""
voice-ai/server/tts.py — Edge TTS streaming synthesis.

Usage:  python3 tts.py "Bonjour, comment allez-vous ?"

Streams MP3 audio chunks to stdout (one `audio` event per chunk, no
header / footer). The Node server forwards each stdout chunk to the
browser as a binary WebSocket frame.

Voice: fr-FR-DeniseNeural (Microsoft Edge free TTS). Swap the VOICE
constant to use another language/voice — see `edge-tts --list-voices`.
"""

import sys
import asyncio
import edge_tts

VOICE = "fr-FR-DeniseNeural"


async def main():
    # Join all argv into one text string. We pass the text as a single
    # argument from the server (the shell-quote happens in Node's
    # `spawn`), but joining argv here is a safety net.
    text = " ".join(sys.argv[1:]).strip()
    if not text:
        return
    communicate = edge_tts.Communicate(text, VOICE)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            sys.stdout.buffer.write(chunk["data"])
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    asyncio.run(main())
