/**
 * AudioWorklet processors for gapless PCM playback and low-latency capture.
 *
 * PCMPlayerProcessor  — Ring-buffer based playback. Receives Int16 PCM chunks
 *                       via MessagePort and outputs Float32 samples continuously.
 *                       Supports instant "clear" for barge-in flushing.
 *
 * PCMCaptureProcessor — Captures Float32 mic input, converts to Int16 PCM,
 *                       and sends via MessagePort for WebSocket transmission.
 */

// ── Playback Processor ──────────────────────────────────────────────
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer: 10 seconds at 24kHz mono (enough for any reasonable TTS chunk)
    this._bufferSize = 24000 * 10;
    this._buffer = new Float32Array(this._bufferSize);
    this._writePos = 0;
    this._readPos = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'audio') {
        this._appendPCM16(e.data.samples);
      } else if (e.data.type === 'clear') {
        // Instant flush for barge-in
        this._writePos = 0;
        this._readPos = 0;
      }
    };
  }

  /**
   * Append Int16 PCM samples to the ring buffer (converted to Float32).
   * @param {Int16Array} int16Samples
   */
  _appendPCM16(int16Samples) {
    for (let i = 0; i < int16Samples.length; i++) {
      this._buffer[this._writePos % this._bufferSize] = int16Samples[i] / 32768;
      this._writePos++;
    }
    // Notify main thread of buffer level (for UI indicators)
    const buffered = this._writePos - this._readPos;
    if (buffered > 0 && buffered % 4800 === 0) {
      this.port.postMessage({ type: 'bufferLevel', samples: buffered });
    }
  }

  /**
   * Called by the audio system for each render quantum (128 samples).
   * Reads from ring buffer; outputs silence when empty.
   */
  process(_inputs, outputs) {
    const output = outputs[0][0];
    if (!output) return true;

    for (let i = 0; i < output.length; i++) {
      if (this._readPos < this._writePos) {
        output[i] = this._buffer[this._readPos % this._bufferSize];
        this._readPos++;
      } else {
        output[i] = 0; // silence when buffer is empty (no gap, just seamless)
      }
    }

    // Report when buffer drains completely (playback finished)
    if (this._readPos >= this._writePos && this._writePos > 0) {
      this.port.postMessage({ type: 'drained' });
      // Reset positions to avoid overflow over long sessions
      this._writePos = 0;
      this._readPos = 0;
    }

    return true;
  }
}

registerProcessor('pcm-player', PCMPlayerProcessor);

// ── Capture Processor ───────────────────────────────────────────────
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  /**
   * Called for each render quantum. Converts Float32 mic input to Int16 PCM
   * and sends via MessagePort.
   */
  process(inputs) {
    const input = inputs[0][0];
    if (!input || input.length === 0) return true;

    const int16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    this.port.postMessage({ pcm: int16.buffer }, [int16.buffer]);
    return true;
  }
}

registerProcessor('pcm-capture', PCMCaptureProcessor);
