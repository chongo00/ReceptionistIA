/**
 * Real-time Voice WebSocket Handler
 * 
 * Provides bidirectional audio streaming for voice conversations:
 * - Receives audio from client browser (PCM 16-bit, 16kHz)
 * - Sends audio back to client (MP3)
 * - Processes speech-to-text and text-to-speech in real-time
 * - Manages conversation state
 */

import { WebSocket, WebSocketServer } from 'ws';
import { createServer, Server as HttpServer } from 'http';
import { 
  createPushStreamRecognizer, 
  isAzureSttConfigured,
  type SpeechLanguage,
} from '../stt/azureSpeechStt.js';
import { 
  synthesizeSpeech, 
  synthesizeSpeechStreaming 
} from '../tts/azureSpeechSdkTts.js';
import { handleUserInput, getConversationState, setConversationState } from '../dialogue/manager.js';

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

const sessions = new Map<string, VoiceSession>();
const SILENCE_TIMEOUT_MS = 2000; // Time after last speech before sending to AI
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes inactivity

/**
 * Message types for WebSocket protocol
 */
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

/**
 * Initialize WebSocket server for voice communication
 */
export function setupVoiceWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ 
    server,
    path: '/ws/voice',
  });
  
  wss.on('connection', (ws, req) => {
    const sessionId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[Voice WS] New connection: ${sessionId}`);
    
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
    
    // Send session ID to client
    send(ws, { type: 'state', data: { sessionId, status: 'connected' } });
    
    ws.on('message', async (data) => {
      try {
        await handleMessage(session, data);
      } catch (error) {
        console.error(`[Voice WS] Error handling message:`, error);
        send(ws, { type: 'error', text: String(error) });
      }
    });
    
    ws.on('close', () => {
      console.log(`[Voice WS] Connection closed: ${sessionId}`);
      cleanupSession(session);
    });
    
    ws.on('error', (err) => {
      console.error(`[Voice WS] Socket error:`, err);
      cleanupSession(session);
    });
  });
  
  // Cleanup inactive sessions periodically
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        console.log(`[Voice WS] Cleaning up inactive session: ${id}`);
        cleanupSession(session);
      }
    }
  }, 60_000);
  
  console.log('[Voice WS] WebSocket server initialized on /ws/voice');
  return wss;
}

async function handleMessage(session: VoiceSession, rawData: WebSocket.RawData) {
  session.lastActivity = Date.now();
  
  // Handle binary audio data
  if (Buffer.isBuffer(rawData) || rawData instanceof ArrayBuffer) {
    await handleAudioData(session, Buffer.from(rawData as ArrayBuffer));
    return;
  }
  
  // Handle JSON messages
  let msg: WsMessage;
  try {
    msg = JSON.parse(rawData.toString()) as WsMessage;
  } catch {
    send(session.ws, { type: 'error', text: 'Invalid message format' });
    return;
  }
  
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
  
  // Get initial greeting from dialogue manager
  const result = await handleUserInput(session.id, null);
  setConversationState(session.id, result.state);
  
  // Send text response
  send(session.ws, { 
    type: 'greeting', 
    text: result.replyText,
    state: result.state,
  });
  
  // Synthesize and send audio
  await speakResponse(session, result.replyText);
}

async function handleLanguageSelect(
  session: VoiceSession, 
  data: { language: SpeechLanguage }
) {
  session.language = data.language;
  const choice = data.language === 'es' ? '1' : '2';
  
  console.log(`[Voice WS] Language selected: ${session.language}`);
  
  // Send language selection to dialogue manager
  const result = await handleUserInput(session.id, choice);
  setConversationState(session.id, result.state);
  
  send(session.ws, { 
    type: 'state', 
    text: result.replyText,
    state: result.state,
  });
  
  // Speak the response
  await speakResponse(session, result.replyText);
  
  // Start listening after greeting
  if (!result.isFinished) {
    await startListening(session);
  }
}

async function handleTextInput(session: VoiceSession, data: { text: string }) {
  if (!data.text?.trim()) return;
  
  console.log(`[Voice WS] Text input: "${data.text}"`);
  
  // Stop listening while processing
  await stopListening(session);
  session.isSpeaking = true;
  
  // Process with dialogue manager
  const result = await handleUserInput(session.id, data.text.trim());
  setConversationState(session.id, result.state);
  
  // Send response
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
    
    const { bytes } = await synthesizeSpeech(text, session.language);
    const audioBase64 = bytes.toString('base64');
    
    send(session.ws, { 
      type: 'audio', 
      audioBase64,
      text,
    });
    
    // Estimate audio duration and wait before marking speech as done
    // MP3 at 48kbps: bytes * 8 / 48000 = seconds
    const estimatedDurationMs = Math.ceil((bytes.length * 8 / 48000) * 1000);
    
    // Wait for audio to play before marking as not speaking
    await new Promise(resolve => setTimeout(resolve, estimatedDurationMs + 200));
    
  } catch (error) {
    console.error(`[Voice WS] TTS error:`, error);
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
  }
  if (session.recognizer) {
    session.recognizer.stop().catch(() => {});
  }
  sessions.delete(session.id);
}

function send(ws: WebSocket, response: WsResponse) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

/**
 * Check if WebSocket voice service is available
 */
export function isVoiceWebSocketReady(): boolean {
  return isAzureSttConfigured();
}
