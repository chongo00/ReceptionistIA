// Docker Piper TTS client — local, free alternative to Azure Speech
import axios from 'axios';
import { loadEnv } from '../config/env.js';

type SpeechLang = 'es' | 'en';

export function isDockerTtsConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.dockerTtsUrl);
}

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
      timeout: 30_000, // Piper can be slow on long phrases
    },
  );

  return {
    bytes: Buffer.from(response.data),
    contentType: 'audio/mpeg',
  };
}
