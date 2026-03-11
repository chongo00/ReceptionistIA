/**
 * TTS Greeting Cache — pre-synthesizes common greeting PCM audio at startup
 * for instant playback on LiveKit, eliminating Azure Speech SDK cold-start latency.
 *
 * Following LiveKit best practices:
 * "For fixed phrases like greetings, provide pre-synthesized audio to save tokens and reduce latency."
 */

import { synthesizeTts } from './ttsProvider.js';

export const PCM_SAMPLE_RATE = 16000;
const FRAME_SIZE_MS = 20;
export const SAMPLES_PER_FRAME = (PCM_SAMPLE_RATE * FRAME_SIZE_MS) / 1000; // 320
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2; // 640

export interface CachedPcmGreeting {
  frames: Int16Array[];
  text: string;
  lang: 'es' | 'en';
}

const cache = new Map<string, CachedPcmGreeting>();

/**
 * Fixed greeting texts returned by the dialogue manager — these never change
 * and are the most common first messages in a call.
 */
const GREETINGS_TO_CACHE: Array<{ key: string; text: string; lang: 'es' | 'en' }> = [
  {
    key: 'no-phone-es',
    text: '¡Hola! Bienvenido a BlindsBook, soy Sara, tu asistente virtual. ¿Me podrías dar tu nombre completo o el número de teléfono con el que te registraste?',
    lang: 'es',
  },
  {
    key: 'no-phone-en',
    text: "Hey there! Welcome to BlindsBook, I'm Sarah, your virtual assistant. Could you give me your full name or the phone number you registered with?",
    lang: 'en',
  },
  {
    key: 'no-match-es',
    text: '¡Hola! Bienvenido a BlindsBook, soy Sara. ¿Me podrías dar tu nombre completo o el número con el que te registraste?',
    lang: 'es',
  },
  {
    key: 'no-match-en',
    text: "Hey! Welcome to BlindsBook, I'm Sarah. Could you give me your full name or the phone number you registered with?",
    lang: 'en',
  },
];

function pcmBufferToFrames(pcmBuffer: Buffer): Int16Array[] {
  const frames: Int16Array[] = [];
  for (let offset = 0; offset < pcmBuffer.length; offset += BYTES_PER_FRAME) {
    const end = Math.min(offset + BYTES_PER_FRAME, pcmBuffer.length);
    const chunkLen = end - offset;
    const samples = new Int16Array(SAMPLES_PER_FRAME);
    for (let i = 0; i < chunkLen / 2 && i < SAMPLES_PER_FRAME; i++) {
      samples[i] = pcmBuffer.readInt16LE(offset + i * 2);
    }
    frames.push(samples);
  }
  return frames;
}

/**
 * Warm up Azure Speech SDK and pre-cache common greetings as PCM frames.
 * Call this once at server startup, AFTER TokenManager is ready.
 */
export async function warmUpAndPreCacheGreetings(): Promise<void> {
  console.log('[TTS Cache] Warming up Azure Speech SDK and pre-caching greetings...');
  const start = Date.now();

  const results = await Promise.allSettled(
    GREETINGS_TO_CACHE.map(async ({ key, text, lang }) => {
      const result = await synthesizeTts(text, lang, 'pcm16k');
      if (result && result.contentType === 'audio/pcm') {
        cache.set(key, { frames: pcmBufferToFrames(result.bytes), text, lang });
        console.log(`[TTS Cache] ✅ Cached '${key}' (${result.bytes.length} bytes, ${cache.get(key)!.frames.length} frames)`);
      } else {
        console.warn(`[TTS Cache] ⚠️ Could not cache '${key}' — TTS returned ${result?.contentType || 'null'}`);
      }
    }),
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  console.log(
    `[TTS Cache] Warm-up complete in ${Date.now() - start}ms — ${cache.size}/${GREETINGS_TO_CACHE.length} greetings cached`,
  );
}

/**
 * Look up cached PCM frames for a greeting text. Returns null if not cached.
 * Exact match on the full text string.
 */
export function getCachedGreetingFrames(text: string): Int16Array[] | null {
  for (const entry of cache.values()) {
    if (entry.text === text) {
      return entry.frames;
    }
  }
  return null;
}
