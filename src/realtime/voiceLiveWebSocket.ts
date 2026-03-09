import { WebSocket, WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import { VoiceLiveClient, type VoiceLiveCallbacks } from '../voiceLive/client.js';

import {
  handleUserInput,
  getConversationState,
  setConversationState,
  clearConversationState,
} from '../dialogue/manager.js';
import { loadEnv, isVoiceLiveConfigured } from '../config/env.js';
import type { SpeechLanguage } from '../stt/azureSpeechStt.js';
import { getSilenceDurationForStep } from '../dialogue/turnTaking.js';
import { pick, BACKCHANNEL_ES, BACKCHANNEL_EN, getReminder } from '../dialogue/humanizer.js';

export { isVoiceLiveConfigured };

const env = loadEnv();
const MAX_CONCURRENT_VL_SESSIONS = 10;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

interface VLTestSession {
  id: string;
  ws: WebSocket;
  vlClient: VoiceLiveClient | null;
  language: SpeechLanguage;
  callerId: string | null;
  companyPhone: string | null;
  isProcessing: boolean;
  isSpeaking: boolean;
  pendingTranscription: string | null;
  audioAccumulator: Buffer[];
  lastActivity: number;
  initAt: number;
  reminderTimer: NodeJS.Timeout | null;
  backchannelTimer: NodeJS.Timeout | null;
  /** Resolves when session.updated is received from Voice Live (config applied) */
  sessionUpdatedResolve: (() => void) | null;
  sessionUpdatedPromise: Promise<void> | null;
}

interface WsMessage {
  type: 'init' | 'audio' | 'text' | 'language' | 'hangup' | 'ping';
  data?: unknown;
}

interface WsResponse {
  type: 'greeting' | 'interim' | 'final' | 'audio' | 'state' | 'error' | 'finished' | 'pong' | 'clear';
  data?: unknown;
  text?: string;
  audioBase64?: string;
  state?: unknown;
}

const sessions = new Map<string, VLTestSession>();
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function send(ws: WebSocket, response: WsResponse) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

export function setupVoiceLiveTestWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    if (sessions.size >= MAX_CONCURRENT_VL_SESSIONS) {
      console.warn(`[VL Test] Rejecting connection — at capacity (${sessions.size}/${MAX_CONCURRENT_VL_SESSIONS})`);
      send(ws, { type: 'error', text: 'Voice Live test at max capacity. Try again later.' });
      ws.close(1013, 'Server at capacity');
      return;
    }

    const sessionId = `vl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[VL Test] New connection: ${sessionId} (${sessions.size + 1}/${MAX_CONCURRENT_VL_SESSIONS})`);

    const session: VLTestSession = {
      id: sessionId,
      ws,
      vlClient: null,
      language: env.defaultLanguage ?? 'en',
      callerId: null,
      companyPhone: null,
      isProcessing: false,
      isSpeaking: false,
      pendingTranscription: null,
      audioAccumulator: [],
      lastActivity: Date.now(),
      initAt: Date.now(),
      reminderTimer: null,
      backchannelTimer: null,
      sessionUpdatedResolve: null,
      sessionUpdatedPromise: null,
    };

    sessions.set(sessionId, session);
    send(ws, { type: 'state', data: { sessionId, status: 'connected' } });

    ws.on('message', async (data, isBinary) => {
      try {
        session.lastActivity = Date.now();

        if (isBinary) {
          await handleAudioData(session, Buffer.from(data as ArrayBuffer));
          return;
        }

        let msg: WsMessage;
        try {
          const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
          msg = JSON.parse(text) as WsMessage;
        } catch {
          send(ws, { type: 'error', text: 'Invalid message format' });
          return;
        }

        console.log(`[VL Test] Message type=${msg.type} for ${sessionId}`);

        switch (msg.type) {
          case 'init':
            await handleInit(session, msg.data as { callerId?: string; companyPhone?: string; language?: SpeechLanguage });
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
            send(ws, { type: 'pong' });
            break;
          default:
            send(ws, { type: 'error', text: `Unknown message type: ${msg.type}` });
        }
      } catch (error) {
        console.error(`[VL Test] Error handling message:`, error);
        send(ws, { type: 'error', text: String(error) });
      }
    });

    ws.on('close', () => {
      console.log(`[VL Test] Connection closed: ${sessionId} (${sessions.size - 1} remaining)`);
      cleanupSession(session);
    });

    ws.on('error', (err) => {
      console.error(`[VL Test] Socket error for ${sessionId}:`, err);
      cleanupSession(session);
    });
  });

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        console.log(`[VL Test] Cleaning up inactive session: ${id}`);
        try { send(session.ws, { type: 'finished', text: 'Session expired due to inactivity' }); } catch { /* ok */ }
        cleanupSession(session);
      }
    }
  }, 60_000);

  console.log(`[VL Test] WebSocket server initialized on /ws/voice-live-test (max ${MAX_CONCURRENT_VL_SESSIONS} sessions)`);
  return wss;
}

export function shutdownVoiceLiveTestWebSocket(): void {
  if (cleanupInterval) clearInterval(cleanupInterval);
  for (const [, session] of sessions) {
    try { send(session.ws, { type: 'finished', text: 'Server shutting down' }); } catch { /* ok */ }
    cleanupSession(session);
  }
}

// ── Handlers ──

async function handleInit(
  session: VLTestSession,
  data: { callerId?: string; companyPhone?: string; language?: SpeechLanguage },
) {
  session.callerId = data.callerId ?? null;
  session.companyPhone = data.companyPhone ?? null;
  session.language = data.language ?? env.defaultLanguage ?? 'en';

  console.log(`[VL Test] Session ${session.id} initialized — caller: ${session.callerId}, lang: ${session.language}`);

  // Set language on conversation state so dialogue manager uses it
  const existingState = getConversationState(session.id);
  existingState.language = session.language;
  if (session.callerId && !existingState.callerPhone) {
    existingState.callerPhone = session.callerId;
  }
  setConversationState(session.id, existingState);

  if (!isVoiceLiveConfigured()) {
    send(session.ws, { type: 'error', text: 'Voice Live no configurado en el servidor (VOICE_LIVE_ENDPOINT, VOICE_LIVE_API_KEY, VOICE_LIVE_MODEL). Usa el backend "Local" o configura el .env y reinicia con: docker compose up -d --force-recreate' });
    const result = await handleUserInput(session.id, null);
    setConversationState(session.id, result.state);
    send(session.ws, { type: 'greeting', text: result.replyText, state: result.state });
    return;
  }

  // Run Voice Live connection AND greeting computation in parallel to cut startup time
  const t0 = Date.now();

  // Create a promise that resolves when session.updated arrives (config applied)
  session.sessionUpdatedPromise = new Promise<void>((resolve) => {
    session.sessionUpdatedResolve = resolve;
    // Safety timeout: don't block greeting forever if session.updated never arrives
    setTimeout(() => {
      if (session.sessionUpdatedResolve) {
        console.warn(`[VL Test] session.updated timeout for ${session.id} — proceeding anyway`);
        session.sessionUpdatedResolve = null;
        resolve();
      }
    }, 3000);
  });

  const vlConnectPromise = (async () => {
    try {
      const callbacks = createCallbacks(session);
      session.vlClient = new VoiceLiveClient(callbacks);

      await session.vlClient.connect(
        env.voiceLiveEndpoint!,
        env.voiceLiveApiKey!,
        env.voiceLiveModel!,
        env.voiceLiveApiVersion,
      );

      // Configure session: Mode A — no auto-response, STT + VAD
      session.vlClient.sendSessionUpdate({
        instructions: 'You are Sara, a warm and friendly receptionist for BlindsBook. Speak in a natural, conversational tone as if you are on a phone call. Use natural pacing with slight pauses between sentences. Never sound robotic or rushed.',
        turn_detection: {
          type: 'azure_semantic_vad_multilingual',
          create_response: false,
          silence_duration_ms: 500,
          remove_filler_words: true,
          languages: [session.language === 'en' ? 'en' : 'es', session.language === 'en' ? 'es' : 'en'],
        },
        input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' },
        input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
        input_audio_sampling_rate: 16000,
        voice: resolveVoice(session.language),
        modalities: ['text', 'audio'],
        input_audio_transcription: { model: 'azure-speech', language: session.language },
      });

      // Wait for session.updated so voice/VAD config is applied before we speak
      await session.sessionUpdatedPromise;

      console.log(`[VL Test] Voice Live connected & configured in ${Date.now() - t0}ms`);
      return true;
    } catch (err) {
      console.error(`[VL Test] Voice Live connect failed for ${session.id}:`, err);
      send(session.ws, { type: 'error', text: `Voice Live connection failed: ${err}` });
      return false;
    }
  })();

  const greetingPromise = (async () => {
    try {
      const result = await handleUserInput(session.id, null);
      setConversationState(session.id, result.state);
      console.log(`[VL Test] Greeting computed in ${Date.now() - t0}ms: step=${result.state.step}`);
      return result;
    } catch (err) {
      console.error(`[VL Test] handleInit dialogue error:`, err);
      return null;
    }
  })();

  // Wait for both in parallel
  const [vlConnected, greetingResult] = await Promise.all([vlConnectPromise, greetingPromise]);

  const tInit = Date.now() - t0;
  console.log(`[VL Test] Init complete in ${tInit}ms (parallel) for ${session.id}`);

  // Send text greeting to browser immediately
  if (greetingResult) {
    send(session.ws, { type: 'greeting', text: greetingResult.replyText, state: greetingResult.state });

    // Speak greeting via Voice Live TTS
    const vlReady = vlConnected && session.vlClient?.sessionReady;
    console.log(`[VL Test] Greeting TTS: vlConnected=${vlConnected}, clientConnected=${session.vlClient?.connected}, sessionReady=${session.vlClient?.sessionReady}, will_speak=${!!vlReady}`);

    if (vlReady && session.vlClient) {
      session.isSpeaking = true;
      send(session.ws, { type: 'state', data: { speaking: true } });
      session.vlClient.speakText(greetingResult.replyText);
      console.log(`[VL Test] speakText() called for greeting: "${greetingResult.replyText.substring(0, 60)}..."`);
    } else {
      console.warn(`[VL Test] Skipping TTS — Voice Live not ready. Text-only greeting sent.`);
    }
  } else {
    send(session.ws, { type: 'greeting', text: '¡Hola! Bienvenido a BlindsBook, soy Sara. ¿En qué te puedo ayudar?', state: {} });
  }
}

async function handleLanguageSelect(
  session: VLTestSession,
  data: { language: SpeechLanguage },
) {
  session.language = data.language;
  console.log(`[VL Test] Language selected: ${session.language} for ${session.id}`);

  // Update Voice Live config for new language
  if (session.vlClient?.connected) {
    session.vlClient.sendSessionUpdate({
      voice: resolveVoice(data.language),
      input_audio_transcription: { model: 'azure-speech', language: data.language },
      turn_detection: {
        type: 'azure_semantic_vad_multilingual',
        create_response: false,
        silence_duration_ms: 500,
        languages: [data.language === 'en' ? 'en' : 'es', data.language === 'en' ? 'es' : 'en'],
      },
    });
  }

  // Process language selection through dialogue manager
  try {
    const choice = data.language === 'es' ? '1' : '2';
    const result = await handleUserInput(session.id, choice);
    setConversationState(session.id, result.state);

    send(session.ws, { type: 'state', text: result.replyText, state: result.state });

    if (!result.isFinished && session.vlClient?.connected) {
      session.isSpeaking = true;
      send(session.ws, { type: 'state', data: { speaking: true } });
      session.vlClient.speakText(result.replyText);
    }
  } catch (err) {
    console.error(`[VL Test] handleLanguageSelect error:`, err);
    send(session.ws, { type: 'error', text: String(err) });
  }
}

async function handleTextInput(session: VLTestSession, data: { text: string }) {
  if (!data.text?.trim()) return;
  const inputText = data.text.trim();
  console.log(`[VL Test] Text input for ${session.id}: "${inputText}"`);

  // Queue if already processing — never silently drop
  if (session.isProcessing) {
    session.pendingTranscription = inputText;
    console.log(`[VL Test] Queued text input (busy) for ${session.id}: "${inputText}"`);
    return;
  }

  await processTranscription(session, inputText);
}

async function handleAudioData(session: VLTestSession, audioBuffer: Buffer) {
  if (!session.vlClient?.connected) return;

  // Barge-in: if speaking, cancel current TTS and flush browser audio
  if (session.isSpeaking) {
    session.vlClient.cancelResponse();
    session.isSpeaking = false;
    session.audioAccumulator = [];
    send(session.ws, { type: 'clear' });
    send(session.ws, { type: 'state', data: { speaking: false } });
  }

  // Forward PCM audio to Voice Live as base64
  session.vlClient.sendAudio(audioBuffer.toString('base64'));
}

async function handleHangup(session: VLTestSession) {
  console.log(`[VL Test] Hangup requested for ${session.id}`);
  if (session.vlClient) {
    session.vlClient.close();
    session.vlClient = null;
  }
  send(session.ws, { type: 'finished', text: 'Call ended' });
  session.ws.close();
}

// ── Voice Live Callbacks ──

async function processTranscription(session: VLTestSession, text: string): Promise<void> {
  session.isProcessing = true;
  console.log(`[VL Test] Processing transcription for ${session.id}: "${text}"`);

  // Show transcribed text to browser
  send(session.ws, { type: 'interim', text });

  // Track whether streaming pipeline spoke sentences already
  let streamedSentenceCount = 0;

  // Callback for streaming: speak each sentence via Voice Live TTS as it arrives from LLM
  const onSentence = (sentence: string) => {
    streamedSentenceCount++;
    console.log(`[VL Test] Streaming sentence #${streamedSentenceCount} for ${session.id}: "${sentence.substring(0, 50)}..."`);

    if (session.vlClient?.connected) {
      if (streamedSentenceCount === 1) {
        session.isSpeaking = true;
        send(session.ws, { type: 'state', data: { speaking: true } });
      }
      session.vlClient.speakSentence(sentence);
    }
  };

  try {
    const result = await handleUserInput(session.id, text, onSentence);
    setConversationState(session.id, result.state);

    // ── Auto language switch: reconfigure Voice Live if language changed ──
    if (result.languageChanged) {
      session.language = result.languageChanged;
      console.log(`[VL Test] Language auto-switched to '${session.language}' for ${session.id}`);

      send(session.ws, { type: 'state', data: { languageDetected: session.language } });

      if (session.vlClient?.connected) {
        session.vlClient.sendSessionUpdate({
          voice: resolveVoice(session.language),
          input_audio_transcription: { model: 'azure-speech', language: session.language },
          turn_detection: {
            type: 'azure_semantic_vad_multilingual',
            create_response: false,
            silence_duration_ms: 500,
            languages: [session.language === 'en' ? 'en' : 'es', session.language === 'en' ? 'es' : 'en'],
          },
        });
      }
    }

    send(session.ws, {
      type: result.isFinished ? 'finished' : 'final',
      text: result.replyText,
      state: result.state,
    });

    // Only trigger full TTS if streaming pipeline didn't speak any sentences
    if (streamedSentenceCount === 0 && !result.isFinished && session.vlClient?.connected) {
      session.isSpeaking = true;
      send(session.ws, { type: 'state', data: { speaking: true } });
      session.vlClient.speakText(result.replyText);
    } else if (streamedSentenceCount > 0) {
      console.log(`[VL Test] Streaming pipeline spoke ${streamedSentenceCount} sentence(s) — skipping full speakText`);
    }

    // Update silence duration based on the new dialogue step
    if (!result.isFinished && session.vlClient?.connected) {
      const baseSilenceMs = Math.round(500 + (1 - env.turnResponsiveness) * 1000);
      const stepSilenceMs = getSilenceDurationForStep(result.state.step, baseSilenceMs);
      session.vlClient.sendSessionUpdate({
        turn_detection: {
          type: 'azure_semantic_vad_multilingual',
          create_response: false,
          silence_duration_ms: stepSilenceMs,
        },
      });
    }
  } catch (err) {
    console.error(`[VL Test] Processing error for ${session.id}:`, err);
    send(session.ws, { type: 'error', text: String(err) });
  } finally {
    session.isProcessing = false;

    // Process queued transcription if any
    if (session.pendingTranscription) {
      const queued = session.pendingTranscription;
      session.pendingTranscription = null;
      console.log(`[VL Test] Processing queued transcription for ${session.id}: "${queued}"`);
      await processTranscription(session, queued);
    }
  }
}

function createCallbacks(session: VLTestSession): VoiceLiveCallbacks {
  return {
    onSessionCreated: () => {
      console.log(`[VL Test] Voice Live session created for ${session.id}`);
    },

    onSessionUpdated: () => {
      console.log(`[VL Test] Voice Live session updated for ${session.id}`);
      if (session.sessionUpdatedResolve) {
        session.sessionUpdatedResolve();
        session.sessionUpdatedResolve = null;
      }
    },

    onSpeechStarted: () => {
      // Barge-in: cancel TTS if speaking + flush browser audio
      if (session.isSpeaking && session.vlClient) {
        session.vlClient.cancelResponse();
        session.isSpeaking = false;
        session.audioAccumulator = [];
        send(session.ws, { type: 'clear' });
        send(session.ws, { type: 'state', data: { speaking: false } });
      }
      cancelReminderTimer(session);
      cancelBackchannelTimer(session);
      send(session.ws, { type: 'state', data: { listening: true } });
    },

    onSpeechStopped: () => {
      send(session.ws, { type: 'state', data: { listening: false } });
      startBackchannelTimer(session);
    },

    onTranscriptionCompleted: async (text: string) => {
      if (!text.trim()) return;
      cancelBackchannelTimer(session);
      cancelReminderTimer(session);

      // Queue transcription if already processing — never silently drop
      if (session.isProcessing) {
        session.pendingTranscription = text.trim();
        console.log(`[VL Test] Queued transcription (busy) for ${session.id}: "${text.trim()}"`);
        return;
      }

      await processTranscription(session, text.trim());
    },

    onAudioDelta: (base64Audio: string, responseId: string) => {
      // Log first audio chunk per response to confirm TTS is producing audio
      if (!session.audioAccumulator.length) {
        console.log(`[VL Test] First audio delta received for ${session.id} (responseId=${responseId}, bytes=${base64Audio.length})`);
      }
      // Stream raw PCM directly — AudioWorklet on the browser handles it natively
      send(session.ws, {
        type: 'audio',
        audioBase64: base64Audio,
        data: { format: 'pcm', sampleRate: 24000, responseId },
      });
    },

    onAudioDone: (_responseId: string) => {
      // All audio chunks already sent progressively — just clean up
      session.audioAccumulator = [];
    },

    onAudioTranscriptDelta: (_text: string) => {
      // Could be used for debugging what Voice Live TTS is saying
    },

    onResponseDone: (_responseId: string) => {
      session.isSpeaking = false;
      send(session.ws, { type: 'state', data: { speaking: false } });
      startReminderTimer(session);
    },

    onError: (error: Error) => {
      console.error(`[VL Test] Voice Live error for ${session.id}:`, error);
      send(session.ws, { type: 'error', text: `Voice Live: ${error.message}` });
    },

    onClose: () => {
      console.log(`[VL Test] Voice Live connection closed for ${session.id}`);
    },
  };
}

// ── Helpers ──

function resolveVoice(language: SpeechLanguage) {
  return {
    name: language === 'en'
      ? (env.azureTtsVoiceEn || 'en-US-JennyNeural')
      : (env.azureTtsVoiceEs || 'es-MX-DaliaNeural'),
    type: 'azure-standard' as const,
    temperature: 0.9,
    rate: '1.05',
  };
}

// ── Reminder timer ─────────────────────────────────────────────────────

function startReminderTimer(session: VLTestSession): void {
  cancelReminderTimer(session);
  const state = getConversationState(session.id);
  if (!state || state.step === 'completed' || state.step === 'creatingAppointment') return;

  session.reminderTimer = setTimeout(async () => {
    if (session.isProcessing || session.isSpeaking) return;
    const currentState = getConversationState(session.id);
    const reminder = getReminder(currentState.step, currentState.language);
    console.log(`[VL Test] Sending reminder for ${session.id}: "${reminder}"`);
    if (session.vlClient?.connected) {
      session.isSpeaking = true;
      send(session.ws, { type: 'state', data: { speaking: true } });
      session.vlClient.speakText(reminder);
    }
  }, env.reminderTriggerMs);
}

function cancelReminderTimer(session: VLTestSession): void {
  if (session.reminderTimer) {
    clearTimeout(session.reminderTimer);
    session.reminderTimer = null;
  }
}

// ── Backchanneling ─────────────────────────────────────────────────────

function startBackchannelTimer(session: VLTestSession): void {
  cancelBackchannelTimer(session);
  if (!env.enableBackchanneling) return;

  session.backchannelTimer = setTimeout(() => {
    if (session.isSpeaking || session.isProcessing) return;
    const state = getConversationState(session.id);
    const phrases = state.language === 'en' ? BACKCHANNEL_EN : BACKCHANNEL_ES;
    const phrase = pick(phrases);
    console.log(`[VL Test] Backchannel for ${session.id}: "${phrase}"`);
    if (session.vlClient?.connected) {
      session.vlClient.speakText(phrase);
    }
  }, 2000);
}

function cancelBackchannelTimer(session: VLTestSession): void {
  if (session.backchannelTimer) {
    clearTimeout(session.backchannelTimer);
    session.backchannelTimer = null;
  }
}

function cleanupSession(session: VLTestSession) {
  if (session.vlClient) {
    session.vlClient.close();
    session.vlClient = null;
  }
  cancelReminderTimer(session);
  cancelBackchannelTimer(session);
  session.audioAccumulator = [];
  clearConversationState(session.id);
  sessions.delete(session.id);
}
