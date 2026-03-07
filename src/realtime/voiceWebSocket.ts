import { WebSocket, WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import {
  createPushStreamRecognizer,
  isAzureSttConfigured,
  type SpeechLanguage,
} from '../stt/azureSpeechStt.js';
import {
  synthesizeSpeech,
  synthesizeSpeechStreaming,
  getTtsStats,
} from '../tts/azureSpeechSdkTts.js';

const USE_STREAMING_TTS_FOR_SENTENCES = true;
import { handleUserInput, getConversationState, setConversationState, clearConversationState } from '../dialogue/manager.js';
import { loadEnv, isVoiceLiveConfigured } from '../config/env.js';
import { VoiceLiveClient, type VoiceLiveCallbacks } from '../voiceLive/client.js';
import { pcmToWav } from '../voiceLive/audioUtils.js';

const env = loadEnv();
const MAX_CONCURRENT_SESSIONS = env.maxConcurrentSessions;
const SILENCE_TIMEOUT_MS = 2000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min inactivity

interface VoiceSession {
  id: string;
  ws: WebSocket;
  language: SpeechLanguage;
  callerId: string | null;
  companyPhone: string | null;
  recognizer: ReturnType<typeof createPushStreamRecognizer> | null;
  isListening: boolean;
  isSpeaking: boolean;
  lastActivity: number;
  interimText: string;
  silenceTimer: NodeJS.Timeout | null;
  currentTtsId: string | undefined;
  pendingBargeIn: boolean;
  initAt: number;
  languageSelectedAt: number | null;
  speechFinalAt: number | null;
  // Voice Live integration (only used when voiceBackend === 'voice_live')
  voiceBackend: 'local' | 'voice_live';
  vlClient: VoiceLiveClient | null;
  vlAudioAccumulator: Buffer[];
  vlResponseResolve: (() => void) | null;
}

interface WsMessage {
  type: 'init' | 'audio' | 'text' | 'language' | 'hangup' | 'ping';
  data?: unknown;
}

interface WsResponse {
  type: 'greeting' | 'interim' | 'final' | 'audio' | 'state' | 'error' | 'finished' | 'pong';
  data?: unknown;
  text?: string;
  audioBase64?: string;
  state?: unknown;
}

const sessions = new Map<string, VoiceSession>();
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;

export function getSessionStats() {
  return { active: sessions.size, max: MAX_CONCURRENT_SESSIONS, tts: getTtsStats() };
}

export function setupVoiceWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
      console.warn(`[Voice WS] Rejecting connection — at capacity (${sessions.size}/${MAX_CONCURRENT_SESSIONS})`);
      ws.send(JSON.stringify({
        type: 'error',
        text: 'El sistema está al máximo de capacidad. Por favor intente en unos minutos.',
      }));
      ws.close(1013, 'Server at capacity');
      return;
    }

    const sessionId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[Voice WS] New connection: ${sessionId} (${sessions.size + 1}/${MAX_CONCURRENT_SESSIONS} sessions)`);

    const session: VoiceSession = {
      id: sessionId,
      ws,
      language: 'es',
      callerId: null,
      companyPhone: null,
      recognizer: null,
      isListening: false,
      isSpeaking: false,
      lastActivity: Date.now(),
      interimText: '',
      silenceTimer: null,
      currentTtsId: undefined,
      pendingBargeIn: false,
      initAt: Date.now(),
      languageSelectedAt: null,
      speechFinalAt: null,
      voiceBackend: (env.voiceBackend === 'voice_live' && isVoiceLiveConfigured()) ? 'voice_live' : 'local',
      vlClient: null,
      vlAudioAccumulator: [],
      vlResponseResolve: null,
    };

    sessions.set(sessionId, session);

    send(ws, { type: 'state', data: { sessionId, status: 'connected' } });

    ws.on('message', async (data, isBinary) => {
      try {
        await handleMessage(session, data, isBinary);
      } catch (error) {
        console.error(`[Voice WS] Error handling message:`, error);
        send(ws, { type: 'error', text: String(error) });
      }
    });

    ws.on('close', () => {
      console.log(`[Voice WS] Connection closed: ${sessionId} (${sessions.size - 1} remaining)`);
      cleanupSession(session);
    });

    ws.on('error', (err) => {
      console.error(`[Voice WS] Socket error for ${sessionId}:`, err);
      cleanupSession(session);
    });
  });

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        console.log(`[Voice WS] Cleaning up inactive session: ${id}`);
        try { send(session.ws, { type: 'finished', text: 'Session expired due to inactivity' }); } catch { /* ok */ }
        cleanupSession(session);
      }
    }
  }, 60_000);

  statsInterval = setInterval(() => {
    if (sessions.size > 0) {
      const tts = getTtsStats();
      console.log(`[Voice WS] Stats: ${sessions.size} sessions, TTS: ${tts.active}/${tts.max} active (${tts.queued} queued)`);
    }
  }, 5 * 60_000);

  console.log(`[Voice WS] WebSocket server initialized on /ws/voice (max ${MAX_CONCURRENT_SESSIONS} concurrent sessions)`);
  return wss;
}

export async function shutdownVoiceWebSocket(): Promise<void> {
  console.log(`[Voice WS] Shutting down — closing ${sessions.size} active sessions...`);

  if (cleanupInterval) clearInterval(cleanupInterval);
  if (statsInterval) clearInterval(statsInterval);

  const closePromises: Promise<void>[] = [];
  for (const [, session] of sessions) {
    try {
      send(session.ws, { type: 'finished', text: 'Server shutting down' });
      session.ws.close(1001, 'Server shutting down');
    } catch { /* ok */ }
    closePromises.push(
      stopListening(session).catch(() => {})
    );
  }
  await Promise.allSettled(closePromises);

  for (const [, session] of sessions) {
    cleanupSession(session);
  }
  console.log('[Voice WS] All sessions closed');
}

async function handleMessage(session: VoiceSession, rawData: WebSocket.RawData, isBinary: boolean) {
  session.lastActivity = Date.now();

  // Binary frames = raw audio, text frames = JSON control messages
  if (isBinary) {
    await handleAudioData(session, Buffer.from(rawData as ArrayBuffer));
    return;
  }

  let msg: WsMessage;
  try {
    const text = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
    msg = JSON.parse(text) as WsMessage;
  } catch {
    send(session.ws, { type: 'error', text: 'Invalid message format' });
    return;
  }

  console.log(`[Voice WS] Message type=${msg.type} for session ${session.id}`);

  switch (msg.type) {
    case 'init':
      await handleInit(session, msg.data as {
        callerId?: string;
        companyPhone?: string;
        language?: SpeechLanguage;
      });
      break;

    case 'language':
      await handleLanguageSelect(session, msg.data as { language: SpeechLanguage });
      break;

    case 'text':
      await handleTextInput(session, msg.data as { text: string });
      break;

    case 'hangup':
      await handleHangup(session);
      break;

    case 'ping':
      send(session.ws, { type: 'pong' });
      break;

    default:
      send(session.ws, { type: 'error', text: `Unknown message type: ${msg.type}` });
  }
}

async function handleInit(
  session: VoiceSession,
  data: { callerId?: string; companyPhone?: string; language?: SpeechLanguage }
) {
  session.callerId = data.callerId ?? null;
  session.companyPhone = data.companyPhone ?? null;
  if (data.language) session.language = data.language;

  console.log(`[Voice WS] Session ${session.id} initialized - caller: ${session.callerId}`);

  if (session.callerId) {
    const existingState = getConversationState(session.id);
    if (!existingState.callerPhone) {
      existingState.callerPhone = session.callerId;
      setConversationState(session.id, existingState);
    }
  }

  // Initialize Voice Live backend if configured
  if (session.voiceBackend === 'voice_live') {
    try {
      await initVoiceLiveForSession(session);
    } catch (err) {
      console.error(`[Voice WS] Voice Live init failed, falling back to local:`, err);
      session.voiceBackend = 'local';
    }
  }

  try {
    const result = await handleUserInput(session.id, null);
    setConversationState(session.id, result.state);

    console.log(`[Voice WS] Init response ready: step=${result.state.step}, text="${result.replyText.substring(0, 60)}..."`);

    const tConnectToGreeting = Date.now() - session.initAt;
    console.log(`[Voice WS] t_connect_to_greeting=${tConnectToGreeting}ms`);

    send(session.ws, {
      type: 'greeting',
      text: result.replyText,
      state: result.state,
    });

    // Non-blocking TTS — failure should not break the flow
    const ttsPromise = speakResponse(session, result.replyText).catch(err => {
      console.error(`[Voice WS] TTS failed during init (non-blocking):`, err);
    });
    if (!result.isFinished) {
      ttsPromise.then(() => startListening(session)).catch(() => startListening(session));
    }
  } catch (err) {
    console.error(`[Voice WS] handleInit error:`, err);
    send(session.ws, { type: 'greeting', text: 'Para español, presione 1. For English, press 2.', state: {} });
  }
}

async function handleLanguageSelect(
  session: VoiceSession,
  data: { language: SpeechLanguage }
) {
  session.language = data.language;
  session.languageSelectedAt = Date.now();
  const choice = data.language === 'es' ? '1' : '2';

  console.log(`[Voice WS] Language selected: ${session.language} for session ${session.id}`);

  try {
    const result = await handleUserInput(session.id, choice);
    setConversationState(session.id, result.state);

    console.log(`[Voice WS] Language response ready: step=${result.state.step}, text="${result.replyText.substring(0, 60)}..."`);

    if (session.languageSelectedAt != null && result.state.step === 'greeting' && (result.state as { customerId?: number }).customerId) {
      const tLangToIdentified = Date.now() - session.languageSelectedAt;
      console.log(`[Voice WS] t_language_to_identified_greeting=${tLangToIdentified}ms`);
    }

    send(session.ws, {
      type: 'state',
      text: result.replyText,
      state: result.state,
    });

    // TTS runs in parallel so it doesn't block listening startup
    const ttsPromise = speakResponse(session, result.replyText).catch(err => {
      console.error(`[Voice WS] TTS failed during language select:`, err);
    });

    if (!result.isFinished) {
      ttsPromise.then(() => startListening(session)).catch(() => startListening(session));
    }
  } catch (err) {
    console.error(`[Voice WS] handleLanguageSelect error:`, err);
    send(session.ws, { type: 'error', text: String(err) });
  }
}

async function handleTextInput(session: VoiceSession, data: { text: string }) {
  if (!data.text?.trim()) return;

  const inputText = data.text.trim();
  console.log(`[Voice WS] Text input for session ${session.id}: "${inputText}"`);

  await stopListening(session);
  session.isSpeaking = true;

  try {
    const startMs = Date.now();
    const result = await handleUserInput(session.id, inputText);
    setConversationState(session.id, result.state);

    console.log(`[Voice WS] Dialogue response in ${Date.now() - startMs}ms: step=${result.state.step}, finished=${result.isFinished}`);

    send(session.ws, {
      type: result.isFinished ? 'finished' : 'final',
      text: result.replyText,
      state: result.state,
    });

    await speakResponse(session, result.replyText);

    session.isSpeaking = false;

    if (!result.isFinished) {
      await startListening(session);
    }
  } catch (err) {
    console.error(`[Voice WS] handleTextInput error:`, err);
    session.isSpeaking = false;
    send(session.ws, { type: 'error', text: String(err) });
    // Resume listening even after error to avoid dead sessions
    await startListening(session).catch(() => {});
  }
}

function cancelCurrentSpeech(session: VoiceSession): void {
  session.isSpeaking = false;
  session.currentTtsId = undefined;
  session.pendingBargeIn = true;
  send(session.ws, { type: 'state', data: { speaking: false } });
}

async function handleAudioData(session: VoiceSession, audioBuffer: Buffer) {
  // Voice Live backend: forward audio directly
  if (session.voiceBackend === 'voice_live') {
    if (!session.vlClient?.connected) return;
    session.lastActivity = Date.now();
    session.vlClient.sendAudio(audioBuffer.toString('base64'));
    return;
  }

  // Local backend: existing Azure Speech SDK pipeline
  if (session.isSpeaking) {
    cancelCurrentSpeech(session);
    await startListening(session);
  }
  if (!session.recognizer || !session.isListening) return;

  const arrayBuffer = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength
  );
  session.recognizer.pushStream.write(arrayBuffer as ArrayBuffer);

  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
  }

  // Process accumulated interim text after a silence gap
  session.silenceTimer = setTimeout(async () => {
    if (session.interimText.trim()) {
      await processSpeechResult(session, session.interimText.trim());
    }
  }, SILENCE_TIMEOUT_MS);
}

async function startListening(session: VoiceSession) {
  // Voice Live backend: VAD is handled automatically by Voice Live
  if (session.voiceBackend === 'voice_live') {
    send(session.ws, { type: 'state', data: { listening: true } });
    return;
  }

  if (session.isListening || session.isSpeaking) return;
  if (!isAzureSttConfigured()) {
    console.warn('[Voice WS] Azure STT not configured, using text-only mode');
    send(session.ws, { type: 'state', data: { listening: false, textOnly: true } });
    return;
  }

  console.log(`[Voice WS] Starting STT for session ${session.id}`);

  session.interimText = '';

  session.recognizer = createPushStreamRecognizer({
    language: session.language,
    silenceTimeoutMs: 1000,

    onInterim: (result) => {
      session.interimText = result.text;
      send(session.ws, {
        type: 'interim',
        text: result.text,
      });
    },

    onFinal: async (result) => {
      if (result.text.trim()) {
        session.interimText = '';
        await processSpeechResult(session, result.text.trim());
      }
    },

    onSilence: () => {
      if (session.interimText.trim()) {
        processSpeechResult(session, session.interimText.trim());
      }
    },

    onError: (error) => {
      console.error(`[Voice WS] STT error:`, error);
      send(session.ws, { type: 'error', text: `Speech recognition error: ${error.message}` });
    },
  });

  await session.recognizer.start();
  session.isListening = true;

  send(session.ws, { type: 'state', data: { listening: true } });
}

async function stopListening(session: VoiceSession) {
  // Voice Live backend: VAD is handled by Voice Live, nothing to stop
  if (session.voiceBackend === 'voice_live') {
    send(session.ws, { type: 'state', data: { listening: false } });
    return;
  }

  if (!session.isListening || !session.recognizer) return;

  console.log(`[Voice WS] Stopping STT for session ${session.id}`);

  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }

  await session.recognizer.stop();
  session.recognizer = null;
  session.isListening = false;

  send(session.ws, { type: 'state', data: { listening: false } });
}

async function processSpeechResult(session: VoiceSession, text: string) {
  console.log(`[Voice WS] Processing speech: "${text}"`);

  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
  session.speechFinalAt = Date.now();
  await stopListening(session);
  session.isSpeaking = true;
  session.interimText = '';

  try {
    const result = await handleUserInput(session.id, text);
    setConversationState(session.id, result.state);

    send(session.ws, {
      type: result.isFinished ? 'finished' : 'final',
      text: result.replyText,
      state: result.state,
    });

    await speakResponse(session, result.replyText);

    session.isSpeaking = false;

    if (!result.isFinished) {
      await startListening(session);
    }
  } catch (err) {
    console.error(`[Voice WS] processSpeechResult error for session ${session.id}:`, err);
    session.isSpeaking = false;
    send(session.ws, { type: 'error', text: `Processing error: ${String(err)}` });
    // Resume listening to avoid dead sessions
    await startListening(session).catch(() => {});
  }
}

function splitIntoSentences(text: string): string[] {
  const raw = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
  return raw.map(s => s.trim()).filter(s => s.length > 0);
}

function estimatePlaybackMs(byteLength: number): number {
  return Math.ceil((byteLength * 8 / 48000) * 1000);
}

async function speakResponse(session: VoiceSession, text: string) {
  if (!text.trim()) return;

  // Voice Live backend: use Voice Live TTS via response.create
  if (session.voiceBackend === 'voice_live' && session.vlClient?.connected) {
    session.isSpeaking = true;
    send(session.ws, { type: 'state', data: { speaking: true } });

    return new Promise<void>((resolve) => {
      session.vlResponseResolve = resolve;
      session.vlClient!.speakText(text);

      // Safety timeout: resolve after 30s even if no response.done
      setTimeout(() => {
        if (session.vlResponseResolve === resolve) {
          session.vlResponseResolve = null;
          session.isSpeaking = false;
          send(session.ws, { type: 'state', data: { speaking: false } });
          resolve();
        }
      }, 30_000);
    });
  }

  // Local backend: existing Azure Speech SDK TTS pipeline
  const ttsId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  session.currentTtsId = ttsId;
  session.pendingBargeIn = false;

  try {
    session.isSpeaking = true;
    send(session.ws, { type: 'state', data: { speaking: true } });

    const sentences = splitIntoSentences(text);
    const totalStart = Date.now();
    console.log(`[Voice WS] TTS streaming ${sentences.length} sentence(s) for session ${session.id}`);

    for (let i = 0; i < sentences.length; i++) {
      if (session.currentTtsId !== ttsId) break;
      const sentence = sentences[i]!;
      if (!sentence.trim()) continue;

      const isLast = i === sentences.length - 1;
      const sentenceStart = Date.now();
      let firstChunkMs: number | null = null;
      let sentenceByteLength = 0;

      if (USE_STREAMING_TTS_FOR_SENTENCES) {
        await synthesizeSpeechStreaming(sentence, session.language, {
          onAudioChunk: (chunk) => {
            if (session.currentTtsId !== ttsId || session.ws.readyState !== WebSocket.OPEN) return;
            if (firstChunkMs === null) {
              firstChunkMs = Date.now() - sentenceStart;
              if (session.speechFinalAt != null && i === 0) {
                const tUserFinalToFirstChunk = Date.now() - session.speechFinalAt;
                console.log(`[Voice WS] t_user_final_to_first_audio_chunk=${tUserFinalToFirstChunk}ms`);
              }
            }
            sentenceByteLength += chunk.length;
            send(session.ws, {
              type: 'audio',
              audioBase64: chunk.toString('base64'),
              text: sentence,
              data: { sentenceIndex: i, totalSentences: sentences.length, isLastChunk: isLast },
            });
          },
          onComplete: () => {},
          onError: () => {},
        });
      } else {
        const { bytes } = await synthesizeSpeech(sentence, session.language);
        sentenceByteLength = bytes.length;
        if (session.currentTtsId !== ttsId || session.ws.readyState !== WebSocket.OPEN) break;
        if (session.speechFinalAt != null && i === 0) {
          const tUserFinalToFirstChunk = Date.now() - session.speechFinalAt;
          console.log(`[Voice WS] t_user_final_to_first_audio_chunk=${tUserFinalToFirstChunk}ms`);
        }
        send(session.ws, {
          type: 'audio',
          audioBase64: bytes.toString('base64'),
          text: sentence,
          data: { sentenceIndex: i, totalSentences: sentences.length, isLastChunk: isLast },
        });
      }

      if (session.currentTtsId !== ttsId) break;
      const elapsed = Date.now() - sentenceStart;
      console.log(`[Voice WS] Sentence ${i + 1}/${sentences.length} tts_ms=${elapsed} tts_bytes=${sentenceByteLength}${firstChunkMs != null ? ` first_chunk_ms=${firstChunkMs}` : ''}`);

      const playbackMs = estimatePlaybackMs(sentenceByteLength);
      const overlapMs = USE_STREAMING_TTS_FOR_SENTENCES ? (isLast ? 150 : 200) : (isLast ? playbackMs + 150 : Math.max(playbackMs - 300, 200));
      await new Promise(resolve => setTimeout(resolve, overlapMs));
    }

    if (session.currentTtsId === ttsId) {
      console.log(`[Voice WS] TTS complete in ${Date.now() - totalStart}ms`);
    }
  } catch (error) {
    console.error(`[Voice WS] TTS error for session ${session.id}:`, error);
    send(session.ws, { type: 'error', text: `Speech synthesis error: ${String(error)}` });
  } finally {
    if (session.currentTtsId === ttsId) {
      session.currentTtsId = undefined;
    }
    session.isSpeaking = false;
    send(session.ws, { type: 'state', data: { speaking: false } });
  }
}

async function handleHangup(session: VoiceSession) {
  console.log(`[Voice WS] Hangup requested for session ${session.id}`);
  await stopListening(session);
  send(session.ws, { type: 'finished', text: 'Call ended' });
  session.ws.close();
}

function cleanupSession(session: VoiceSession) {
  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
  if (session.recognizer) {
    session.recognizer.stop().catch(() => {});
    session.recognizer = null;
  }
  if (session.vlClient) {
    session.vlClient.close();
    session.vlClient = null;
  }
  session.vlAudioAccumulator = [];
  session.vlResponseResolve = null;
  clearConversationState(session.id);
  sessions.delete(session.id);
}

function send(ws: WebSocket, response: WsResponse) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

// ── Voice Live integration helpers ──

function resolveVoiceForVL(language: SpeechLanguage) {
  return {
    name: language === 'en'
      ? (env.azureTtsVoiceEn || 'en-US-JennyNeural')
      : (env.azureTtsVoiceEs || 'es-MX-DaliaNeural'),
    type: 'azure-standard' as const,
    temperature: 0.8,
  };
}

async function initVoiceLiveForSession(session: VoiceSession): Promise<void> {
  const callbacks = createVoiceLiveCallbacksForSession(session);
  session.vlClient = new VoiceLiveClient(callbacks);

  await session.vlClient.connect(
    env.voiceLiveEndpoint!,
    env.voiceLiveApiKey!,
    env.voiceLiveModel!,
    env.voiceLiveApiVersion,
  );

  session.vlClient.sendSessionUpdate({
    instructions: 'You are a receptionist. When given specific text to repeat, you must repeat it exactly without changes.',
    turn_detection: {
      type: 'azure_semantic_vad_multilingual',
      create_response: false,
      silence_duration_ms: 500,
      languages: [session.language === 'en' ? 'en' : 'es', session.language === 'en' ? 'es' : 'en'],
    },
    input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' },
    input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
    input_audio_sampling_rate: 16000,
    voice: resolveVoiceForVL(session.language),
    modalities: ['text', 'audio'],
    input_audio_transcription: { model: 'azure-speech', language: session.language },
  });

  console.log(`[Voice WS] Voice Live backend initialized for ${session.id}`);
}

function createVoiceLiveCallbacksForSession(session: VoiceSession): VoiceLiveCallbacks {
  return {
    onSessionCreated: () => {
      console.log(`[Voice WS] Voice Live session created for ${session.id}`);
    },
    onSessionUpdated: () => {
      console.log(`[Voice WS] Voice Live session updated for ${session.id}`);
    },
    onSpeechStarted: () => {
      // Barge-in: cancel TTS if speaking
      if (session.isSpeaking) {
        cancelCurrentSpeech(session);
        if (session.vlClient) {
          session.vlClient.cancelResponse();
          session.vlAudioAccumulator = [];
        }
      }
      send(session.ws, { type: 'state', data: { listening: true } });
    },
    onSpeechStopped: () => {
      send(session.ws, { type: 'state', data: { listening: false } });
    },
    onTranscriptionCompleted: async (text: string) => {
      if (!text.trim()) return;
      console.log(`[Voice WS] VL transcription for ${session.id}: "${text}"`);
      send(session.ws, { type: 'interim', text });
      await processSpeechResult(session, text.trim());
    },
    onAudioDelta: (base64Audio: string) => {
      session.vlAudioAccumulator.push(Buffer.from(base64Audio, 'base64'));
    },
    onAudioDone: () => {
      if (session.vlAudioAccumulator.length > 0) {
        const pcm = Buffer.concat(session.vlAudioAccumulator);
        session.vlAudioAccumulator = [];
        const wav = pcmToWav(pcm, 24000, 16, 1);
        send(session.ws, {
          type: 'audio',
          audioBase64: wav.toString('base64'),
        });
      }
    },
    onAudioTranscriptDelta: () => {
      // Debug: what Voice Live TTS is saying
    },
    onResponseDone: () => {
      session.isSpeaking = false;
      send(session.ws, { type: 'state', data: { speaking: false } });
      if (session.vlResponseResolve) {
        session.vlResponseResolve();
        session.vlResponseResolve = null;
      }
    },
    onError: (error: Error) => {
      console.error(`[Voice WS] Voice Live error for ${session.id}:`, error);
      send(session.ws, { type: 'error', text: `Voice Live: ${error.message}` });
    },
    onClose: () => {
      console.log(`[Voice WS] Voice Live connection closed for ${session.id}`);
    },
  };
}

export function isVoiceWebSocketReady(): boolean {
  if (env.voiceBackend === 'voice_live') {
    return isVoiceLiveConfigured();
  }
  return isAzureSttConfigured();
}
