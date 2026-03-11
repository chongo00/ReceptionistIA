import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { loadEnv } from '../config/env.js';

export type SpeechLanguage = 'es' | 'en';

export interface RecognitionResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

export interface SttConfig {
  language: SpeechLanguage;
  /** When true, auto-detect between es-ES and en-US instead of using a fixed language */
  autoDetect?: boolean;
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

function createSttConfig(language: SpeechLanguage, silenceTimeoutMs?: number, autoDetect?: boolean): sdk.SpeechConfig {
  const { key, region } = getCredentials();
  const cfg = sdk.SpeechConfig.fromSubscription(key, region);

  cfg.outputFormat = sdk.OutputFormat.Detailed;
  cfg.setProfanity(sdk.ProfanityOption.Masked);

  // Don't set speechRecognitionLanguage when auto-detect is enabled
  if (!autoDetect) {
    cfg.speechRecognitionLanguage = LANG_CODES[language];
  }

  cfg.setProperty(
    sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
    String(silenceTimeoutMs ?? 1000)
  );
  cfg.setProperty(
    sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
    '10000'
  );

  return cfg;
}

function extractDetectedLanguage(result: sdk.SpeechRecognitionResult): SpeechLanguage | undefined {
  try {
    const autoResult = sdk.AutoDetectSourceLanguageResult.fromResult(result);
    const detectedLang = autoResult.language;
    if (detectedLang?.startsWith('es')) return 'es';
    if (detectedLang?.startsWith('en')) return 'en';
  } catch { /* ignore — not in auto-detect mode */ }
  return undefined;
}

export function createPushStreamRecognizer(
  config: SttConfig
): {
  recognizer: sdk.SpeechRecognizer;
  pushStream: sdk.PushAudioInputStream;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const speechCfg = createSttConfig(config.language, config.silenceTimeoutMs, config.autoDetect);

  const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

  let recognizer: sdk.SpeechRecognizer;

  if (config.autoDetect) {
    const autoDetectConfig = sdk.AutoDetectSourceLanguageConfig.fromLanguages([
      LANG_CODES.es, // es-ES
      LANG_CODES.en, // en-US
    ]);
    recognizer = sdk.SpeechRecognizer.FromConfig(speechCfg, autoDetectConfig, audioConfig);
  } else {
    recognizer = new sdk.SpeechRecognizer(speechCfg, audioConfig);
  }

  recognizer.recognizing = (_, event) => {
    if (event.result.reason === sdk.ResultReason.RecognizingSpeech) {
      config.onInterim?.({
        text: event.result.text,
        isFinal: false,
        language: extractDetectedLanguage(event.result) ?? config.language,
      });
    }
  };

  recognizer.recognized = (_, event) => {
    if (event.result.reason === sdk.ResultReason.RecognizedSpeech) {
      const detailed = event.result as sdk.SpeechRecognitionResult;
      const detectedLang = extractDetectedLanguage(event.result);
      config.onFinal?.({
        text: event.result.text,
        isFinal: true,
        confidence: detailed.properties?.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult)
          ? JSON.parse(detailed.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult))?.NBest?.[0]?.Confidence
          : undefined,
        language: detectedLang ?? config.language,
      });
    } else if (event.result.reason === sdk.ResultReason.NoMatch) {
      config.onSilence?.();
    }
  };

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

export async function recognizeFromBuffer(
  audioBuffer: Buffer,
  language: SpeechLanguage = 'es'
): Promise<RecognitionResult | null> {
  const speechCfg = createSttConfig(language);

  const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);

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

export function isAzureSttConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.azureSpeechKey && env.azureSpeechRegion);
}

export { sdk as SpeechSdk };
