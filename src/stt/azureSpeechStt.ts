/**
 * Azure Speech SDK - Speech-to-Text Service
 * 
 * Uses Microsoft Azure Cognitive Services Speech SDK for professional-grade
 * speech recognition. Much more reliable than browser Web Speech API.
 * 
 * Key features:
 * - Continuous recognition with interim results
 * - Server-side processing (no browser dependency)
 * - Proper silence detection and timeout handling
 * - Support for Spanish and English
 */

import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { loadEnv } from '../config/env.js';
import { Readable } from 'stream';

export type SpeechLanguage = 'es' | 'en';

export interface RecognitionResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

export interface SttConfig {
  language: SpeechLanguage;
  onInterim?: (result: RecognitionResult) => void;
  onFinal?: (result: RecognitionResult) => void;
  onError?: (error: Error) => void;
  onSilence?: () => void;
  silenceTimeoutMs?: number;
}

const LANG_CODES: Record<SpeechLanguage, string> = {
  es: 'es-ES',
  en: 'en-US',
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
  
  // Enable detailed output for better accuracy
  speechConfig.outputFormat = sdk.OutputFormat.Detailed;
  
  // Enable profanity filtering (mask)
  speechConfig.setProfanity(sdk.ProfanityOption.Masked);
  
  return speechConfig;
}

/**
 * Creates a speech recognizer for continuous recognition from a push stream.
 * Used for real-time audio from WebSocket connections.
 */
export function createPushStreamRecognizer(
  config: SttConfig
): {
  recognizer: sdk.SpeechRecognizer;
  pushStream: sdk.PushAudioInputStream;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const speechCfg = getSpeechConfig();
  speechCfg.speechRecognitionLanguage = LANG_CODES[config.language];
  
  // Configure silence detection
  // Segmentation silence: how long to wait after speech ends before finalizing
  speechCfg.setProperty(
    sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, 
    String(config.silenceTimeoutMs ?? 1500)
  );
  
  // Initial silence: how long to wait for speech before giving up
  speechCfg.setProperty(
    sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
    '10000'
  );
  
  // Create push stream for receiving audio data
  const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  
  const recognizer = new sdk.SpeechRecognizer(speechCfg, audioConfig);
  
  // Handle interim results (while speaking)
  recognizer.recognizing = (_, event) => {
    if (event.result.reason === sdk.ResultReason.RecognizingSpeech) {
      config.onInterim?.({
        text: event.result.text,
        isFinal: false,
        language: config.language,
      });
    }
  };
  
  // Handle final results
  recognizer.recognized = (_, event) => {
    if (event.result.reason === sdk.ResultReason.RecognizedSpeech) {
      const detailed = event.result as sdk.SpeechRecognitionResult;
      config.onFinal?.({
        text: event.result.text,
        isFinal: true,
        confidence: detailed.properties?.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult) 
          ? JSON.parse(detailed.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult))?.NBest?.[0]?.Confidence
          : undefined,
        language: config.language,
      });
    } else if (event.result.reason === sdk.ResultReason.NoMatch) {
      config.onSilence?.();
    }
  };
  
  // Handle errors
  recognizer.canceled = (_, event) => {
    if (event.reason === sdk.CancellationReason.Error) {
      config.onError?.(new Error(`Speech recognition error: ${event.errorDetails}`));
    }
  };
  
  return {
    recognizer,
    pushStream,
    start: () => new Promise((resolve, reject) => {
      recognizer.startContinuousRecognitionAsync(
        () => resolve(),
        (error) => reject(new Error(error))
      );
    }),
    stop: () => new Promise((resolve) => {
      recognizer.stopContinuousRecognitionAsync(
        () => {
          pushStream.close();
          resolve();
        },
        () => {
          pushStream.close();
          resolve();
        }
      );
    }),
  };
}

/**
 * Recognize speech from a WAV/PCM audio buffer (single-shot recognition).
 * Used for processing complete audio files or recorded segments.
 */
export async function recognizeFromBuffer(
  audioBuffer: Buffer,
  language: SpeechLanguage = 'es'
): Promise<RecognitionResult | null> {
  const speechCfg = getSpeechConfig();
  speechCfg.speechRecognitionLanguage = LANG_CODES[language];
  
  const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
  
  // Write the buffer to the push stream - convert Buffer to ArrayBuffer
  const arrayBuffer = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength
  );
  pushStream.write(arrayBuffer as ArrayBuffer);
  pushStream.close();
  
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechCfg, audioConfig);
  
  return new Promise((resolve, reject) => {
    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();
        
        if (result.reason === sdk.ResultReason.RecognizedSpeech) {
          resolve({
            text: result.text,
            isFinal: true,
            language,
          });
        } else if (result.reason === sdk.ResultReason.NoMatch) {
          resolve(null);
        } else if (result.reason === sdk.ResultReason.Canceled) {
          const cancellation = sdk.CancellationDetails.fromResult(result);
          reject(new Error(`Recognition canceled: ${cancellation.errorDetails}`));
        } else {
          resolve(null);
        }
      },
      (error) => {
        recognizer.close();
        reject(new Error(error));
      }
    );
  });
}

/**
 * Check if Azure Speech STT is properly configured
 */
export function isAzureSttConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.azureSpeechKey && env.azureSpeechRegion);
}

export { sdk as SpeechSdk };
