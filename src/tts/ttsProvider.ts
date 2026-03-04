import { isAzureTtsConfigured as isAzureSdkConfigured, synthesizeSpeech } from './azureSpeechSdkTts.js';
import { isAzureTtsConfigured, synthesizeAzureMp3 } from './azureNeuralTts.js';

type SpeechLang = 'es' | 'en';

export interface TtsSynthResult {
  bytes: Buffer;
  contentType: string;
  provider: 'azure-sdk' | 'azure-rest';
}

export async function synthesizeTts(
  text: string,
  language: SpeechLang,
): Promise<TtsSynthResult | null> {
  if (isAzureSdkConfigured()) {
    try {
      const result = await synthesizeSpeech(text, language);
      return { ...result, provider: 'azure-sdk' };
    } catch (err) {
      console.warn('[TTS] Azure Speech SDK failed, trying REST fallback:', (err as Error).message);
    }
  }

  if (isAzureTtsConfigured()) {
    try {
      const result = await synthesizeAzureMp3(text, language);
      return { ...result, provider: 'azure-rest' };
    } catch (err) {
      console.warn('[TTS] Azure Speech REST failed:', (err as Error).message);
    }
  }

  return null;
}
