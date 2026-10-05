import sys, asyncio, edge_tts

VOICE = "fr-FR-DeniseNeural"

async def main():
    text = " ".join(sys.argv[1:])
    if not text:
        return
    communicate = edge_tts.Communicate(text, VOICE)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            sys.stdout.buffer.write(chunk["data"])
            sys.stdout.buffer.flush()

if __name__ == "__main__":
    asyncio.run(main())
