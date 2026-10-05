/**
 * voice-ai/client/audio-worklet.js
 *
 * AudioWorkletProcessor that captures the mic at the AudioContext's
 * native sample rate (typically 48 kHz), downsamples to 16 kHz, and
 * posts Int16 PCM chunks to the main thread.
 *
 * The main thread (app.js / page.tsx) forwards these chunks to the
 * voice-ai server over WebSocket as binary frames.
 *
 * Downsample strategy: linear interpolation. For each output sample,
 * we compute the fractional source index and blend two adjacent
 * samples. This is sufficient quality for Vosk's small model — a
 * proper low-pass FIR would be marginally better but linear is
 * cheaper + good enough for speech recognition.
 *
 * Float32 → Int16: clamp to [-1, 1] then scale by 0x7FFF (positive)
 * or 0x8000 (negative). Standard PCM16 encoding.
 *
 * NOTE: the AudioWorkletProcessor runs in a separate audio thread
 * (no DOM, no main-thread globals). All it can do is `postMessage`
 * + read `port.onmessage`. The main thread registers it via
 * `audioCtx.audioWorklet.addModule('audio-worklet.js')`.
 */

class DownsampleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Target sample rate for Vosk.
    this.targetRate = 16000;
    // We learn the source rate from the first process() call —
    // AudioWorkletGlobalScope has `sampleRate` global (the context
    // rate), so we read it once at construction.
    this.sourceRate = sampleRate; // global in AudioWorkletGlobalScope
    // Ratio of source samples per target sample. e.g. 48000/16000 = 3
    // → we emit 1 sample for every 3 source samples.
    this.ratio = this.sourceRate / this.targetRate;
    // Fractional read pointer — accumulates `ratio` per output sample.
    // Carried between process() calls so we don't drop samples at
    // block boundaries.
    this.fractionalIndex = 0;
    // We process blocks of 128 samples (AudioWorklet block size) but
    // emit fewer (128 / ratio). To keep messages small, we buffer
    // Int16 outputs and flush in chunks of ~256 samples (16ms at
    // 16 kHz) — the main thread will batch them up before sending.
    this.buffer = new Int16Array(0);
    this.flushSize = 256;
  }

  /**
   * process(inputs, outputs, parameters) — called by the audio
   * renderer every render quantum (128 samples at the context rate).
   * We read the first input channel, downsample to 16 kHz, and post
   * Int16 chunks to the main thread.
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // Estimate number of output samples for this block.
    const startIdx = this.fractionalIndex;
    const endIdx = startIdx + channel.length;
    const outCount = Math.floor((endIdx - 0) / this.ratio) - Math.floor(startIdx / this.ratio);
    const out = new Int16Array(Math.max(0, outCount));

    let outPos = 0;
    let srcPos = this.fractionalIndex;

    while (srcPos < channel.length - 1) {
      const i = Math.floor(srcPos);
      const frac = srcPos - i;
      // Linear interpolation between channel[i] and channel[i+1].
      const a = channel[i] || 0;
      const b = channel[i + 1] || 0;
      let sample = a + (b - a) * frac;
      // Clamp + convert to Int16.
      const clamped = Math.max(-1, Math.min(1, sample));
      out[outPos++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      srcPos += this.ratio;
    }

    // Carry the fractional index past this block into the next.
    this.fractionalIndex = srcPos - channel.length;

    if (outPos > 0) {
      // Append to our running buffer.
      const merged = new Int16Array(this.buffer.length + outPos);
      merged.set(this.buffer, 0);
      merged.set(out.subarray(0, outPos), this.buffer.length);
      this.buffer = merged;

      // Flush full chunks of `flushSize` samples.
      while (this.buffer.length >= this.flushSize) {
        const chunk = this.buffer.subarray(0, this.flushSize).slice();
        this.port.postMessage(chunk, [chunk.buffer]);
        this.buffer = this.buffer.subarray(this.flushSize);
      }
    }

    return true; // keep the processor alive
  }
}

registerProcessor("downsample-processor", DownsampleProcessor);
