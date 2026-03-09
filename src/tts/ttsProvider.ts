import { isAzureTtsConfigured as isAzureSdkConfigured, synthesizeSpeech, type TtsOutputFormat } from './azureSpeechSdkTts.js';
import { isAzureTtsConfigured, synthesizeAzureMp3 } from './azureNeuralTts.js';

type SpeechLang = 'es' | 'en';

export type { TtsOutputFormat };

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

  // REST fallback only supports MP3 — if PCM was requested but SDK failed, log warning
  if (isAzureTtsConfigured()) {
    if (outputFormat === 'pcm16k') {
      console.warn('[TTS] REST fallback does not support PCM format — falling back to MP3 (audio may not work for LiveKit)');
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
