// Unified TTS provider. Priority: Azure Speech SDK (primary) → REST API fallback → null
// Uses the new Azure Speech SDK for better streaming and natural voice
import { isAzureTtsConfigured as isAzureSdkConfigured, synthesizeSpeech } from './azureSpeechSdkTts.js';
import { isAzureTtsConfigured, synthesizeAzureMp3 } from './azureNeuralTts.js';

type SpeechLang = 'es' | 'en';

export interface TtsSynthResult {
  bytes: Buffer;
  contentType: string;
  provider: 'azure-sdk' | 'azure-rest' | 'docker';
}

export async function synthesizeTts(
  text: string,
  language: SpeechLang,
): Promise<TtsSynthResult | null> {
  // Try Azure Speech SDK first (better streaming, more natural)
  if (isAzureSdkConfigured()) {
    try {
      const result = await synthesizeSpeech(text, language);
      return { ...result, provider: 'azure-sdk' };
    } catch (err) {
      console.warn('[TTS] Azure Speech SDK falló, intentando REST fallback:', (err as Error).message);
    }
  }

  // Fallback to Azure REST API
  if (isAzureTtsConfigured()) {
    try {
      const result = await synthesizeAzureMp3(text, language);
      return { ...result, provider: 'azure-rest' };
    } catch (err) {
      console.warn('[TTS] Azure Speech REST falló:', (err as Error).message);
    }
  }

  return null;
}
