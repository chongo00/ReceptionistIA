import { isAzureTtsConfigured as isAzureSdkConfigured, synthesizeSpeech, synthesizeSpeechStreaming, type TtsOutputFormat, type StreamingTtsCallbacks } from './azureSpeechSdkTts.js';
import { isAzureTtsConfigured, synthesizeAzureMp3 } from './azureNeuralTts.js';

type SpeechLang = 'es' | 'en';

export type { TtsOutputFormat, StreamingTtsCallbacks };

export interface TtsSynthResult {
  bytes: Buffer;
  contentType: string;
  provider: 'azure-sdk' | 'azure-rest';
}

export async function synthesizeTts(
  text: string,
  language: SpeechLang,
  outputFormat: TtsOutputFormat = 'mp3',
): Promise<TtsSynthResult | null> {
  if (isAzureSdkConfigured()) {
    try {
      const result = await synthesizeSpeech(text, language, outputFormat);
      return { ...result, provider: 'azure-sdk' };
    } catch (err) {
      console.warn('[TTS] Azure Speech SDK failed, trying REST fallback:', (err as Error).message);
    }
  }

  // REST fallback only supports MP3. Sending MP3 bytes as raw PCM to LiveKit produces
  // static noise, so we refuse the fallback when PCM is explicitly required.
  if (isAzureTtsConfigured()) {
    if (outputFormat === 'pcm16k') {
      console.error(
        '[TTS] Azure Speech SDK is required for PCM/LiveKit but failed. ' +
        'REST fallback returns MP3 which cannot be used as raw PCM. ' +
        'Check AZURE_SPEECH_KEY / AZURE_SPEECH_REGION and the SDK logs above.',
      );
      return null;
    }
    try {
      const result = await synthesizeAzureMp3(text, language);
      return { ...result, provider: 'azure-rest' };
    } catch (err) {
      console.warn('[TTS] Azure Speech REST failed:', (err as Error).message);
    }
  }

  return null;
}

/**
 * Streaming TTS: calls onAudioChunk with PCM chunks as they arrive from Azure.
 * First audio bytes arrive within ~1-2s instead of waiting for full synthesis.
 */
export async function synthesizeTtsStreaming(
  text: string,
  language: SpeechLang,
  callbacks: StreamingTtsCallbacks,
  outputFormat: TtsOutputFormat = 'pcm16k',
): Promise<void> {
  if (!isAzureSdkConfigured()) {
    callbacks.onError(new Error('Azure Speech SDK not configured for streaming TTS'));
    return;
  }
  return synthesizeSpeechStreaming(text, language, callbacks, outputFormat);
}
