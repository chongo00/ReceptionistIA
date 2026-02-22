// Unified TTS provider. Priority: Docker Piper (free) → Azure Speech (paid) → null (Twilio <Say> fallback)
import { isDockerTtsConfigured, synthesizeDockerMp3 } from './dockerTts.js';
import { isAzureTtsConfigured, synthesizeAzureMp3 } from './azureNeuralTts.js';

type SpeechLang = 'es' | 'en';

export interface TtsSynthResult {
  bytes: Buffer;
  contentType: string;
  provider: 'docker' | 'azure';
}

export async function synthesizeTts(
  text: string,
  language: SpeechLang,
): Promise<TtsSynthResult | null> {
  if (isDockerTtsConfigured()) {
    try {
      const result = await synthesizeDockerMp3(text, language);
      return { ...result, provider: 'docker' };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[TTS] Docker Piper falló, intentando Azure fallback:', (err as Error).message);
    }
  }

  if (isAzureTtsConfigured()) {
    try {
      const result = await synthesizeAzureMp3(text, language);
      return { ...result, provider: 'azure' };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[TTS] Azure Speech falló:', (err as Error).message);
    }
  }

  return null;
}
