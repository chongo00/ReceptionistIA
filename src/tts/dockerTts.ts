/**
 * TTS provider que llama al contenedor Docker BlindsBook-IA (Piper TTS local).
 * Sustituye a Azure Speech — 100 % gratis y sin vendor lock-in.
 *
 * Endpoint: POST {DOCKER_TTS_URL}/tts  →  audio/mpeg (MP3)
 */
import axios from 'axios';
import { loadEnv } from '../config/env.js';

type SpeechLang = 'es' | 'en';

/** Devuelve true si la variable DOCKER_TTS_URL está configurada. */
export function isDockerTtsConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.dockerTtsUrl);
}

/**
 * Sintetiza texto a MP3 usando el Docker BlindsBook-IA (Piper).
 * Compatible con la misma firma de `synthesizeAzureMp3`.
 */
export async function synthesizeDockerMp3(
  text: string,
  language: SpeechLang,
): Promise<{ bytes: Buffer; contentType: string }> {
  const env = loadEnv();
  const baseUrl = env.dockerTtsUrl;
  if (!baseUrl) {
    throw new Error('Docker TTS no está configurado (DOCKER_TTS_URL)');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/tts`;

  const response = await axios.post<ArrayBuffer>(
    url,
    { text, language },
    {
      responseType: 'arraybuffer',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000, // Piper puede tardar un poco en frases largas
    },
  );

  return {
    bytes: Buffer.from(response.data),
    contentType: 'audio/mpeg',
  };
}
