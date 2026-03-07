/**
 * Audio utilities for Voice Live API integration.
 * Voice Live sends/receives raw PCM audio (base64-encoded).
 * The browser's Web Audio API decodeAudioData() requires a container
 * format (WAV) — so we prepend a standard 44-byte RIFF/WAV header.
 */

/**
 * Wrap raw PCM data in a WAV container.
 * Default params match Voice Live output: 24 kHz, 16-bit, mono.
 */
export function pcmToWav(
  pcmBuffer: Buffer,
  sampleRate: number = 24000,
  bitsPerSample: number = 16,
  channels: number = 1,
): Buffer {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // PCM subchunk size
  header.writeUInt16LE(1, 20);            // AudioFormat = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}
