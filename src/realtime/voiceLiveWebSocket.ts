import { WebSocket, WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import { VoiceLiveClient, type VoiceLiveCallbacks } from '../voiceLive/client.js';
import { pcmToWav } from '../voiceLive/audioUtils.js';
import {
  handleUserInput,
  getConversationState,
  setConversationState,
  clearConversationState,
} from '../dialogue/manager.js';
import { loadEnv, isVoiceLiveConfigured } from '../config/env.js';
import type { SpeechLanguage } from '../stt/azureSpeechStt.js';

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
  audioAccumulator: Buffer[];
  lastActivity: number;
  initAt: number;
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
      language: 'es',
      callerId: null,
      companyPhone: null,
      isProcessing: false,
      isSpeaking: false,
      audioAccumulator: [],
      lastActivity: Date.now(),
      initAt: Date.now(),
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
  if (data.language) session.language = data.language;

  console.log(`[VL Test] Session ${session.id} initialized — caller: ${session.callerId}`);

  if (session.callerId) {
    const existingState = getConversationState(session.id);
    if (!existingState.callerPhone) {
      existingState.callerPhone = session.callerId;
      setConversationState(session.id, existingState);
    }
  }

  if (!isVoiceLiveConfigured()) {
    send(session.ws, { type: 'error', text: 'Voice Live no configurado en el servidor (VOICE_LIVE_ENDPOINT, VOICE_LIVE_API_KEY, VOICE_LIVE_MODEL). Usa el backend "Local" o configura el .env y reinicia con: docker compose up -d --force-recreate' });
    const result = await handleUserInput(session.id, null);
    setConversationState(session.id, result.state);
    send(session.ws, { type: 'greeting', text: result.replyText, state: result.state });
    return;
  }

  // Connect to Voice Live API
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
      voice: resolveVoice(session.language),
      modalities: ['text', 'audio'],
      input_audio_transcription: { model: 'azure-speech', language: session.language },
    });
  } catch (err) {
    console.error(`[VL Test] Voice Live connect failed for ${session.id}:`, err);
    send(session.ws, { type: 'error', text: `Voice Live connection failed: ${err}` });
    // Fall through to still return a greeting (text-only mode)
  }

  // Get initial greeting from dialogue manager
  try {
    const result = await handleUserInput(session.id, null);
    setConversationState(session.id, result.state);

    const tGreeting = Date.now() - session.initAt;
    console.log(`[VL Test] Init greeting ready: step=${result.state.step} t_greeting=${tGreeting}ms`);

    send(session.ws, { type: 'greeting', text: result.replyText, state: result.state });

    // Speak greeting via Voice Live TTS
    if (session.vlClient?.connected) {
      session.isSpeaking = true;
      send(session.ws, { type: 'state', data: { speaking: true } });
      session.vlClient.speakText(result.replyText);
    }
  } catch (err) {
    console.error(`[VL Test] handleInit dialogue error:`, err);
    send(session.ws, { type: 'greeting', text: 'Para español, presione 1. For English, press 2.', state: {} });
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
  if (!data.text?.trim() || session.isProcessing) return;
  const inputText = data.text.trim();
  console.log(`[VL Test] Text input for ${session.id}: "${inputText}"`);

  session.isProcessing = true;

  try {
    const result = await handleUserInput(session.id, inputText);
    setConversationState(session.id, result.state);

    send(session.ws, {
      type: result.isFinished ? 'finished' : 'final',
      text: result.replyText,
      state: result.state,
    });

    if (!result.isFinished && session.vlClient?.connected) {
      session.isSpeaking = true;
      send(session.ws, { type: 'state', data: { speaking: true } });
      session.vlClient.speakText(result.replyText);
    }
  } catch (err) {
    console.error(`[VL Test] handleTextInput error:`, err);
    send(session.ws, { type: 'error', text: String(err) });
  } finally {
    session.isProcessing = false;
  }
}

async function handleAudioData(session: VLTestSession, audioBuffer: Buffer) {
  if (!session.vlClient?.connected) return;

  // Barge-in: if speaking, cancel current TTS
  if (session.isSpeaking) {
    session.vlClient.cancelResponse();
    session.isSpeaking = false;
    session.audioAccumulator = [];
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

function createCallbacks(session: VLTestSession): VoiceLiveCallbacks {
  return {
    onSessionCreated: () => {
      console.log(`[VL Test] Voice Live session created for ${session.id}`);
    },

    onSessionUpdated: () => {
      console.log(`[VL Test] Voice Live session updated for ${session.id}`);
    },

    onSpeechStarted: () => {
      // Barge-in: cancel TTS if speaking
      if (session.isSpeaking && session.vlClient) {
        session.vlClient.cancelResponse();
        session.isSpeaking = false;
        session.audioAccumulator = [];
        send(session.ws, { type: 'state', data: { speaking: false } });
      }
      send(session.ws, { type: 'state', data: { listening: true } });
    },

    onSpeechStopped: () => {
      send(session.ws, { type: 'state', data: { listening: false } });
    },

    onTranscriptionCompleted: async (text: string) => {
      if (!text.trim() || session.isProcessing) return;

      session.isProcessing = true;
      console.log(`[VL Test] Transcription for ${session.id}: "${text}"`);

      // Show transcribed text to browser
      send(session.ws, { type: 'interim', text });

      try {
        const result = await handleUserInput(session.id, text.trim());
        setConversationState(session.id, result.state);

        send(session.ws, {
          type: result.isFinished ? 'finished' : 'final',
          text: result.replyText,
          state: result.state,
        });

        // Trigger TTS via Voice Live
        if (!result.isFinished && session.vlClient?.connected) {
          session.isSpeaking = true;
          send(session.ws, { type: 'state', data: { speaking: true } });
          session.vlClient.speakText(result.replyText);
        }
      } catch (err) {
        console.error(`[VL Test] Processing error for ${session.id}:`, err);
        send(session.ws, { type: 'error', text: String(err) });
      } finally {
        session.isProcessing = false;
      }
    },

    onAudioDelta: (base64Audio: string) => {
      // Accumulate PCM chunks from Voice Live TTS
      session.audioAccumulator.push(Buffer.from(base64Audio, 'base64'));
    },

    onAudioDone: () => {
      // Wrap accumulated PCM in WAV and send to browser
      if (session.audioAccumulator.length > 0) {
        const pcm = Buffer.concat(session.audioAccumulator);
        session.audioAccumulator = [];
        const wav = pcmToWav(pcm, 24000, 16, 1);
        send(session.ws, {
          type: 'audio',
          audioBase64: wav.toString('base64'),
        });
      }
    },

    onAudioTranscriptDelta: (_text: string) => {
      // Could be used for debugging what Voice Live TTS is saying
    },

    onResponseDone: () => {
      session.isSpeaking = false;
      send(session.ws, { type: 'state', data: { speaking: false } });
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
    temperature: 0.8,
  };
}

function cleanupSession(session: VLTestSession) {
  if (session.vlClient) {
    session.vlClient.close();
    session.vlClient = null;
  }
  session.audioAccumulator = [];
  clearConversationState(session.id);
  sessions.delete(session.id);
}
