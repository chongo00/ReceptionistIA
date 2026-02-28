/**
 * Azure Speech SDK - Text-to-Speech Service (Enhanced)
 * 
 * Uses Microsoft Azure Cognitive Services Speech SDK for professional-grade
 * text-to-speech synthesis with:
 * - Streaming audio output (lower latency)
 * - Neural voices with emotional styles
 * - Advanced SSML for natural prosody
 * - Audio streaming for real-time playback
 */

import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { loadEnv } from '../config/env.js';
import { enrichSsmlBody } from '../dialogue/humanizer.js';

type SpeechLang = 'es' | 'en';

/**
 * Voice configurations for maximum naturalness.
 * 
 * Best voices for conversational AI (2024):
 * - es-MX-JorgeNeural: Most natural Mexican Spanish, very conversational
 * - es-ES-ElviraNeural: Warm, professional Spanish from Spain
 * - en-US-JennyNeural: Very natural, friendly American English
 * - en-US-AvaMultilingualNeural: New multilingual voice, extremely natural
 */
const VOICE_CONFIG: Record<SpeechLang, {
  name: string;
  style?: string;
  styleDegree?: number;
}> = {
  es: {
    name: 'es-MX-JorgeNeural',  // More natural conversational voice
    style: 'cheerful',
    styleDegree: 0.8,  // Not too cheerful, just friendly
  },
  en: {
    name: 'en-US-JennyNeural',
    style: 'friendly', 
    styleDegree: 0.9,
  },
};

let speechConfig: sdk.SpeechConfig | null = null;

function getSpeechConfig(): sdk.SpeechConfig {
  if (speechConfig) return speechConfig;
  
  const env = loadEnv();
  const key = env.azureSpeechKey;
  const region = env.azureSpeechRegion;
  
  if (!key || !region) {
    throw new Error('Azure Speech not configured (AZURE_SPEECH_KEY/AZURE_SPEECH_REGION)');
  }
  
  speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
  
  // High quality audio output
  speechConfig.speechSynthesisOutputFormat = 
    sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
  
  return speechConfig;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Build advanced SSML for natural speech with:
 * - Emotional styles (express-as)
 * - Natural pauses
 * - Prosody variations
 * - Emphasis on key words
 */
function buildNaturalSsml(text: string, language: SpeechLang): string {
  const config = VOICE_CONFIG[language];
  const voiceName = config.name;
  const langTag = voiceName.split('-').slice(0, 2).join('-');
  
  // Enrich the text body with natural pauses and prosody
  const enrichedBody = enrichSsmlBody(escapeXml(text));
  
  // Build voice content with optional style
  let voiceContent: string;
  
  if (config.style) {
    // Use mstts:express-as for emotional styles
    // styledegree: 0.01-2.0 (1.0 = default intensity)
    voiceContent = `
      <mstts:express-as style="${config.style}" styledegree="${config.styleDegree ?? 1}">
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
      <voice name="${voiceName}">
        ${voiceContent}
      </voice>
    </speak>
  `.trim();
}

/**
 * Synthesize speech with streaming support.
 * Returns audio data as a Buffer.
 */
export async function synthesizeSpeech(
  text: string,
  language: SpeechLang = 'es'
): Promise<{ bytes: Buffer; contentType: string }> {
  const config = getSpeechConfig();
  const voiceConfig = VOICE_CONFIG[language];
  
  // Override voice if configured in env
  const env = loadEnv();
  const envVoice = language === 'en' ? env.azureTtsVoiceEn : env.azureTtsVoiceEs;
  if (envVoice) {
    voiceConfig.name = envVoice;
  }
  
  config.speechSynthesisVoiceName = voiceConfig.name;
  
  const synthesizer = new sdk.SpeechSynthesizer(config, undefined);
  const ssml = buildNaturalSsml(text, language);
  
  return new Promise((resolve, reject) => {
    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        synthesizer.close();
        
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve({
            bytes: Buffer.from(result.audioData),
            contentType: 'audio/mpeg',
          });
        } else if (result.reason === sdk.ResultReason.Canceled) {
          const cancellation = sdk.CancellationDetails.fromResult(result);
          reject(new Error(`TTS canceled: ${cancellation.errorDetails}`));
        } else {
          reject(new Error(`TTS failed with reason: ${result.reason}`));
        }
      },
      (error) => {
        synthesizer.close();
        reject(new Error(error));
      }
    );
  });
}

export interface StreamingTtsCallbacks {
  onAudioChunk: (chunk: Buffer) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

/**
 * Synthesize speech with streaming callbacks.
 * Useful for real-time audio playback - starts playing before full synthesis.
 */
export async function synthesizeSpeechStreaming(
  text: string,
  language: SpeechLang,
  callbacks: StreamingTtsCallbacks
): Promise<void> {
  const config = getSpeechConfig();
  const voiceConfig = VOICE_CONFIG[language];
  
  // Override voice if configured in env
  const env = loadEnv();
  const envVoice = language === 'en' ? env.azureTtsVoiceEn : env.azureTtsVoiceEs;
  if (envVoice) {
    voiceConfig.name = envVoice;
  }
  
  config.speechSynthesisVoiceName = voiceConfig.name;
  
  // Use pull stream for streaming output
  const pullStream = sdk.AudioOutputStream.createPullStream();
  const audioConfig = sdk.AudioConfig.fromStreamOutput(pullStream);
  const synthesizer = new sdk.SpeechSynthesizer(config, audioConfig);
  
  const ssml = buildNaturalSsml(text, language);
  
  // Handle streaming audio data
  synthesizer.synthesizing = (_, event) => {
    if (event.result.audioData && event.result.audioData.byteLength > 0) {
      callbacks.onAudioChunk(Buffer.from(event.result.audioData));
    }
  };
  
  return new Promise((resolve, reject) => {
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
}

/**
 * Get list of available neural voices for a language.
 * Useful for letting users choose their preferred voice.
 */
export async function getAvailableVoices(language: SpeechLang): Promise<sdk.VoiceInfo[]> {
  const config = getSpeechConfig();
  const synthesizer = new sdk.SpeechSynthesizer(config, undefined);
  const locale = VOICE_CONFIG[language].name.split('-').slice(0, 2).join('-');
  
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
