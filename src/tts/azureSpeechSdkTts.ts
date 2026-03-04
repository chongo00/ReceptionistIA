import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { loadEnv } from '../config/env.js';
import { enrichSsmlBody } from '../dialogue/humanizer.js';

export type SpeechLang = 'es' | 'en';

interface VoiceProfile {
  readonly name: string;
  readonly style?: string;
  readonly styleDegree?: number;
}

const DEFAULT_VOICES: Readonly<Record<SpeechLang, VoiceProfile>> = {
  es: { name: 'es-MX-JorgeNeural', style: 'cheerful', styleDegree: 0.8 },
  en: { name: 'en-US-JennyNeural', style: 'friendly', styleDegree: 0.9 },
};

let _azureKey: string | null = null;
let _azureRegion: string | null = null;

function getCredentials(): { key: string; region: string } {
  if (_azureKey && _azureRegion) return { key: _azureKey, region: _azureRegion };

  const env = loadEnv();
  if (!env.azureSpeechKey || !env.azureSpeechRegion) {
    throw new Error('Azure Speech not configured (AZURE_SPEECH_KEY/AZURE_SPEECH_REGION)');
  }
  _azureKey = env.azureSpeechKey;
  _azureRegion = env.azureSpeechRegion;
  return { key: _azureKey, region: _azureRegion };
}

function resolveVoice(language: SpeechLang): VoiceProfile {
  const env = loadEnv();
  const envVoice = language === 'en' ? env.azureTtsVoiceEn : env.azureTtsVoiceEs;
  const base = DEFAULT_VOICES[language];
  return envVoice ? { ...base, name: envVoice } : base;
}

function createSpeechConfig(voice: VoiceProfile): sdk.SpeechConfig {
  const { key, region } = getCredentials();
  const cfg = sdk.SpeechConfig.fromSubscription(key, region);
  cfg.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
  cfg.speechSynthesisVoiceName = voice.name;
  return cfg;
}

const MAX_CONCURRENT_TTS = 15;
let _activeTts = 0;
const _ttsQueue: Array<{ resolve: () => void }> = [];

async function acquireTtsSlot(): Promise<void> {
  if (_activeTts < MAX_CONCURRENT_TTS) { _activeTts++; return; }
  return new Promise(resolve => _ttsQueue.push({ resolve }));
}

function releaseTtsSlot(): void {
  const next = _ttsQueue.shift();
  if (next) { next.resolve(); } else { _activeTts = Math.max(0, _activeTts - 1); }
}

export function getTtsStats() {
  return { active: _activeTts, queued: _ttsQueue.length, max: MAX_CONCURRENT_TTS };
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildNaturalSsml(text: string, voice: VoiceProfile): string {
  const langTag = voice.name.split('-').slice(0, 2).join('-');
  const enrichedBody = enrichSsmlBody(escapeXml(text));

  let voiceContent: string;

  if (voice.style) {
    voiceContent = `
      <mstts:express-as style="${voice.style}" styledegree="${voice.styleDegree ?? 1}">
        <prosody rate="+3%" pitch="+1%">
          ${enrichedBody}
        </prosody>
      </mstts:express-as>
    `;
  } else {
    voiceContent = `
      <prosody rate="+3%" pitch="+1%">
        ${enrichedBody}
      </prosody>
    `;
  }

  return `
    <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
           xmlns:mstts="https://www.w3.org/2001/mstts"
           xml:lang="${langTag}">
      <voice name="${voice.name}">
        ${voiceContent}
      </voice>
    </speak>
  `.trim();
}

const TTS_TIMEOUT_MS = 10_000;

export async function synthesizeSpeech(
  text: string,
  language: SpeechLang = 'es'
): Promise<{ bytes: Buffer; contentType: string }> {
  await acquireTtsSlot();

  const voice = resolveVoice(language);
  const cfg = createSpeechConfig(voice);
  const synthesizer = new sdk.SpeechSynthesizer(cfg, undefined);
  const ssml = buildNaturalSsml(text, voice);

  const startMs = Date.now();
  console.log(`[TTS] Starting synthesis (${language}, voice=${voice.name}, len=${text.length}, active=${_activeTts}/${MAX_CONCURRENT_TTS})`);

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  try {
    const ttsPromise = new Promise<{ bytes: Buffer; contentType: string }>((resolve, reject) => {
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          if (settled) return;
          settled = true;
          if (timeoutId) clearTimeout(timeoutId);
          synthesizer.close();

          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            console.log(`[TTS] Completed in ${Date.now() - startMs}ms (${result.audioData.byteLength} bytes)`);
            resolve({ bytes: Buffer.from(result.audioData), contentType: 'audio/mpeg' });
          } else if (result.reason === sdk.ResultReason.Canceled) {
            const cancellation = sdk.CancellationDetails.fromResult(result);
            reject(new Error(`TTS canceled: ${cancellation.errorDetails}`));
          } else {
            reject(new Error(`TTS failed with reason: ${result.reason}`));
          }
        },
        (error) => {
          if (settled) return;
          settled = true;
          if (timeoutId) clearTimeout(timeoutId);
          synthesizer.close();
          reject(new Error(error));
        }
      );
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { synthesizer.close(); } catch { /* already closed */ }
        reject(new Error(`TTS timeout after ${TTS_TIMEOUT_MS}ms`));
      }, TTS_TIMEOUT_MS);
    });

    return await Promise.race([ttsPromise, timeoutPromise]);
  } finally {
    releaseTtsSlot();
  }
}

export interface StreamingTtsCallbacks {
  onAudioChunk: (chunk: Buffer) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

export async function synthesizeSpeechStreaming(
  text: string,
  language: SpeechLang,
  callbacks: StreamingTtsCallbacks
): Promise<void> {
  await acquireTtsSlot();

  const voice = resolveVoice(language);
  const cfg = createSpeechConfig(voice);

  const pullStream = sdk.AudioOutputStream.createPullStream();
  const audioConfig = sdk.AudioConfig.fromStreamOutput(pullStream);
  const synthesizer = new sdk.SpeechSynthesizer(cfg, audioConfig);

  const ssml = buildNaturalSsml(text, voice);

  synthesizer.synthesizing = (_, event) => {
    if (event.result.audioData && event.result.audioData.byteLength > 0) {
      callbacks.onAudioChunk(Buffer.from(event.result.audioData));
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          synthesizer.close();
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            callbacks.onComplete();
            resolve();
          } else if (result.reason === sdk.ResultReason.Canceled) {
            const cancellation = sdk.CancellationDetails.fromResult(result);
            const error = new Error(`TTS canceled: ${cancellation.errorDetails}`);
            callbacks.onError(error);
            reject(error);
          } else {
            const error = new Error(`TTS failed with reason: ${result.reason}`);
            callbacks.onError(error);
            reject(error);
          }
        },
        (error) => {
          synthesizer.close();
          const err = new Error(error);
          callbacks.onError(err);
          reject(err);
        }
      );
    });
  } finally {
    releaseTtsSlot();
  }
}

export async function getAvailableVoices(language: SpeechLang): Promise<sdk.VoiceInfo[]> {
  const voice = resolveVoice(language);
  const cfg = createSpeechConfig(voice);
  const synthesizer = new sdk.SpeechSynthesizer(cfg, undefined);
  const locale = voice.name.split('-').slice(0, 2).join('-');

  return new Promise((resolve, reject) => {
    synthesizer.getVoicesAsync(locale)
      .then((result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.VoicesListRetrieved) {
          resolve(result.voices);
        } else {
          reject(new Error('Failed to get voices'));
        }
      })
      .catch((error: unknown) => {
        synthesizer.close();
        reject(new Error(String(error)));
      });
  });
}

export function isAzureTtsConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.azureSpeechKey && env.azureSpeechRegion);
}
