/**
 * Real-time Voice WebSocket Handler
 * 
 * Provides bidirectional audio streaming for voice conversations:
 * - Receives audio from client browser (PCM 16-bit, 16kHz)
 * - Sends audio back to client (MP3)
 * - Processes speech-to-text and text-to-speech in real-time
 * - Manages conversation state per session (concurrency-safe)
 * - Limits concurrent sessions and graceful shutdown
 */

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
import { handleUserInput, getConversationState, setConversationState, clearConversationState } from '../dialogue/manager.js';

/* ── Configuration ── */
const MAX_CONCURRENT_SESSIONS = 20;
const SILENCE_TIMEOUT_MS = 2000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min inactivity

/* ── Session types ── */
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

/* ── Session store ── */
const sessions = new Map<string, VoiceSession>();
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;

export function getSessionStats() {
  return { active: sessions.size, max: MAX_CONCURRENT_SESSIONS, tts: getTtsStats() };
}

/**
 * Initialize WebSocket server for voice communication
 */
export function setupVoiceWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/voice' });

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

  // Periodic cleanup of inactive sessions
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

  // Periodic stats logging (every 5 min)
  statsInterval = setInterval(() => {
    if (sessions.size > 0) {
      const tts = getTtsStats();
      console.log(`[Voice WS] Stats: ${sessions.size} sessions, TTS: ${tts.active}/${tts.max} active (${tts.queued} queued)`);
    }
  }, 5 * 60_000);

  console.log(`[Voice WS] WebSocket server initialized on /ws/voice (max ${MAX_CONCURRENT_SESSIONS} concurrent sessions)`);
  return wss;
}

/**
 * Graceful shutdown: close all active sessions and free resources
 */
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
  
  // Binary frames = raw audio data
  if (isBinary) {
    await handleAudioData(session, Buffer.from(rawData as ArrayBuffer));
    return;
  }
  
  // Text frames = JSON control messages
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

  // Set caller phone in conversation state before processing
  if (session.callerId) {
    const existingState = getConversationState(session.id);
    if (!existingState.callerPhone) {
      existingState.callerPhone = session.callerId;
      setConversationState(session.id, existingState);
    }
  }
  
  try {
    // Get initial greeting from dialogue manager
    const result = await handleUserInput(session.id, null);
    setConversationState(session.id, result.state);
    
    console.log(`[Voice WS] Init response ready: step=${result.state.step}, text="${result.replyText.substring(0, 60)}..."`);
    
    // Send text response immediately (don't wait for TTS)
    send(session.ws, { 
      type: 'greeting', 
      text: result.replyText,
      state: result.state,
    });
    
    // Try TTS but don't block the flow if it fails
    speakResponse(session, result.replyText).catch(err => {
      console.error(`[Voice WS] TTS failed during init (non-blocking):`, err);
    });
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
  const choice = data.language === 'es' ? '1' : '2';
  
  console.log(`[Voice WS] Language selected: ${session.language} for session ${session.id}`);
  
  try {
    const result = await handleUserInput(session.id, choice);
    setConversationState(session.id, result.state);
    
    console.log(`[Voice WS] Language response ready: step=${result.state.step}, text="${result.replyText.substring(0, 60)}..."`);
    
    // Send text immediately
    send(session.ws, { 
      type: 'state', 
      text: result.replyText,
      state: result.state,
    });
    
    // TTS in parallel — don't block listening startup
    const ttsPromise = speakResponse(session, result.replyText).catch(err => {
      console.error(`[Voice WS] TTS failed during language select:`, err);
    });
    
    // Start listening without waiting for TTS to finish
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
    
    // Send text immediately
    send(session.ws, {
      type: result.isFinished ? 'finished' : 'final',
      text: result.replyText,
      state: result.state,
    });
    
    // TTS then resume listening
    await speakResponse(session, result.replyText);
    
    session.isSpeaking = false;
    
    if (!result.isFinished) {
      await startListening(session);
    }
  } catch (err) {
    console.error(`[Voice WS] handleTextInput error:`, err);
    session.isSpeaking = false;
    send(session.ws, { type: 'error', text: String(err) });
    // Try to resume listening even after error
    await startListening(session).catch(() => {});
  }
}

async function handleAudioData(session: VoiceSession, audioBuffer: Buffer) {
  if (!session.recognizer || !session.isListening) return;
  
  // Push audio to the recognizer - convert Buffer to ArrayBuffer
  const arrayBuffer = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength
  );
  session.recognizer.pushStream.write(arrayBuffer as ArrayBuffer);
  
  // Reset silence timer
  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
  }
  
  // Set new silence timer - triggers processing after silence
  session.silenceTimer = setTimeout(async () => {
    if (session.interimText.trim()) {
      await processSpeechResult(session, session.interimText.trim());
    }
  }, SILENCE_TIMEOUT_MS);
}

async function startListening(session: VoiceSession) {
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
    silenceTimeoutMs: 1500,
    
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
      // Silence detected - if we have interim text, process it
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
  
  // Stop listening while processing
  await stopListening(session);
  session.isSpeaking = true;
  session.interimText = '';
  
  // Process with dialogue manager
  const result = await handleUserInput(session.id, text);
  setConversationState(session.id, result.state);
  
  // Send final text confirmation
  send(session.ws, {
    type: result.isFinished ? 'finished' : 'final',
    text: result.replyText,
    state: result.state,
  });
  
  // Speak the response
  await speakResponse(session, result.replyText);
  
  session.isSpeaking = false;
  
  // Resume listening if not finished
  if (!result.isFinished) {
    await startListening(session);
  }
}

async function speakResponse(session: VoiceSession, text: string) {
  if (!text.trim()) return;

  try {
    session.isSpeaking = true;
    send(session.ws, { type: 'state', data: { speaking: true } });

    console.log(`[Voice WS] TTS starting for session ${session.id}: "${text.substring(0, 50)}..."`);
    const startMs = Date.now();
    const { bytes } = await synthesizeSpeech(text, session.language);
    console.log(`[Voice WS] TTS completed in ${Date.now() - startMs}ms, ${bytes.length} bytes`);
    
    const audioBase64 = bytes.toString('base64');

    send(session.ws, {
      type: 'audio',
      audioBase64,
      text,
    });

    // MP3 at 48kbps: bytes * 8 / 48000 = seconds
    const estimatedDurationMs = Math.ceil((bytes.length * 8 / 48000) * 1000);
    const waitMs = Math.min(estimatedDurationMs + 200, 15_000);
    await new Promise(resolve => setTimeout(resolve, waitMs));

  } catch (error) {
    console.error(`[Voice WS] TTS error for session ${session.id}:`, error);
    send(session.ws, { type: 'error', text: `Speech synthesis error: ${String(error)}` });
  } finally {
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
  // Free dialogue state for this session
  clearConversationState(session.id);
  sessions.delete(session.id);
}

function send(ws: WebSocket, response: WsResponse) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

export function isVoiceWebSocketReady(): boolean {
  return isAzureSttConfigured();
}
