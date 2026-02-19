/**
 * Proveedor unificado de TTS.
 * Cadena de prioridad:
 *   1. Docker BlindsBook-IA (Piper local, $0)
 *   2. Azure Speech (neuronal, pago)
 *   3. null  → el consumidor usa Twilio <Say> como último recurso
 */
import { isDockerTtsConfigured, synthesizeDockerMp3 } from './dockerTts.js';
import { isAzureTtsConfigured, synthesizeAzureMp3 } from './azureNeuralTts.js';

type SpeechLang = 'es' | 'en';

export interface TtsSynthResult {
  bytes: Buffer;
  contentType: string;
  provider: 'docker' | 'azure';
}

/**
 * Intenta sintetizar con el proveedor de mayor prioridad disponible.
 * Devuelve `null` si ninguno está configurado/funciona → fallback a <Say>.
 */
export async function synthesizeTts(
  text: string,
  language: SpeechLang,
): Promise<TtsSynthResult | null> {
  // 1) Docker Piper (primera opción — gratis y local)
  if (isDockerTtsConfigured()) {
    try {
      const result = await synthesizeDockerMp3(text, language);
      return { ...result, provider: 'docker' };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[TTS] Docker Piper falló, intentando Azure fallback:', (err as Error).message);
    }
  }

  // 2) Azure Speech (segunda opción — neuronal de pago)
  if (isAzureTtsConfigured()) {
    try {
      const result = await synthesizeAzureMp3(text, language);
      return { ...result, provider: 'azure' };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[TTS] Azure Speech falló:', (err as Error).message);
    }
  }

  // 3) Ninguno disponible
  return null;
}
