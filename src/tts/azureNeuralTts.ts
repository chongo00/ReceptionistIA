import axios from 'axios';
import { loadEnv } from '../config/env.js';
import { enrichSsmlBody } from '../dialogue/humanizer.js';

type SpeechLang = 'es' | 'en';

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function isAzureTtsConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.azureSpeechKey && env.azureSpeechRegion);
}

export async function synthesizeAzureMp3(
  text: string,
  language: SpeechLang,
): Promise<{ bytes: Buffer; contentType: string }> {
  const env = loadEnv();
  const key = env.azureSpeechKey;
  const region = env.azureSpeechRegion;
  if (!key || !region) {
    throw new Error('Azure TTS no está configurado (AZURE_SPEECH_KEY/AZURE_SPEECH_REGION)');
  }

  const voiceName =
    language === 'en'
      ? env.azureTtsVoiceEn || 'en-US-JennyNeural'
      : env.azureTtsVoiceEs || 'es-MX-DaliaNeural';

  const langTag = language === 'en' ? 'en-US' : 'es-MX';

  const enrichedBody = enrichSsmlBody(escapeXml(text));

  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${langTag}">` +
    `<voice name="${voiceName}">${enrichedBody}</voice>` +
    `</speak>`;

  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const response = await axios.post<ArrayBuffer>(url, ssml, {
    responseType: 'arraybuffer',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'blindsbook-receptionist-ai',
    },
    timeout: 15_000,
  });

  return {
    bytes: Buffer.from(response.data),
    contentType: 'audio/mpeg',
  };
}

