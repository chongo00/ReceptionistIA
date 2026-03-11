/**
 * LiveKit Bot Participant
 *
 * Server-side bot that joins a LiveKit room, receives user audio,
 * sends bot audio, and forwards data messages (transcriptions, state, etc.)
 *
 * Architecture:
 *   Browser ──WebRTC──► LiveKit Cloud ──WebRTC──► Bot (this file)
 *                                                   │
 *                           DialogueManager ◄───────┘
 *                                │
 *              TTS ◄─────────────┘───────────► LLM
 */

import {
  Room,
  RoomEvent,
  AudioSource,
  AudioStream,
  AudioFrame,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  DataPacketKind,
} from '@livekit/rtc-node';
import { loadEnv } from '../config/env.js';
import { generateLiveKitToken } from '../realtime/livekitTransport.js';
import { handleUserInput, getConversationState, setConversationState, clearConversationState } from '../dialogue/manager.js';
import { synthesizeTts, synthesizeTtsStreaming } from '../tts/ttsProvider.js';
import { getCachedGreetingFrames, PCM_SAMPLE_RATE, SAMPLES_PER_FRAME } from '../tts/ttsGreetingCache.js';
import { getSilenceDurationForStep } from '../dialogue/turnTaking.js';
import { getReminder } from '../dialogue/humanizer.js';
import { createPushStreamRecognizer, isAzureSttConfigured } from '../stt/azureSpeechStt.js';

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const FRAME_SIZE_MS = 20; // 20ms frames = 320 samples at 16kHz

export interface BotSession {
  room: Room;
  audioSource: AudioSource;
  callId: string;
  roomName: string;
  isClosed: boolean;
  // Timers
  silenceTimer: ReturnType<typeof setTimeout> | null;
  reminderTimer: ReturnType<typeof setTimeout> | null;
  disconnectGraceTimer: ReturnType<typeof setTimeout> | null;
  // STT (Azure Speech-to-Text)
  sttRecognizer: ReturnType<typeof createPushStreamRecognizer> | null;
  sttStarted: boolean;
  sttLanguage: 'es' | 'en' | 'auto';
  interimText: string;
  // Audio accumulator for STT
  audioBuffer: Int16Array[];
  speechActive: boolean;
}

const activeSessions = new Map<string, BotSession>();

/**
 * Create a bot participant that joins a LiveKit room and handles the voice dialogue.
 * Returns the bot's token so the server can give it to the browser for room name reference.
 */
export async function createBotSession(roomName: string, callId: string): Promise<{ botToken: string; roomName: string }> {
  const env = loadEnv();
  const botIdentity = `bot-${callId}`;

  // Generate token for the bot participant
  const botToken = await generateLiveKitToken(roomName, botIdentity);

  const room = new Room();
  const audioSource = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);

  const session: BotSession = {
    room,
    audioSource,
    callId,
    roomName,
    isClosed: false,
    silenceTimer: null,
    reminderTimer: null,
    disconnectGraceTimer: null,
    sttRecognizer: null,
    sttStarted: false,
    sttLanguage: 'auto',
    interimText: '',
    audioBuffer: [],
    speechActive: false,
  };

  activeSessions.set(callId, session);

  // --- Room event handlers ---

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (track.kind === 1 /* KIND_AUDIO */ && !session.isClosed) {
      console.log(`[LiveKit Bot] Subscribed to audio track from ${participant.identity}`);
      handleRemoteAudioTrack(session, track);
    }
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    console.log(`[LiveKit Bot] Participant ${participant.identity} disconnected`);
    // If the user leaves, start a grace period before closing.
    // WebRTC renegotiations can cause brief disconnect/reconnect — don't kill the session instantly.
    if (!participant.identity.startsWith('bot-')) {
      if (session.disconnectGraceTimer) clearTimeout(session.disconnectGraceTimer);
      session.disconnectGraceTimer = setTimeout(() => {
        // Check if a user is back in the room
        const stillHasUser = Array.from(room.remoteParticipants.values())
          .some((p: RemoteParticipant) => !p.identity.startsWith('bot-'));
        if (!stillHasUser && !session.isClosed) {
          console.log(`[LiveKit Bot] User still absent after grace period — closing session ${callId}`);
          closeBotSession(callId);
        }
      }, 5000);
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log(`[LiveKit Bot] Room disconnected for call ${callId}`);
    closeBotSession(callId);
  });

  room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, kind?: DataPacketKind, topic?: string) => {
    if (topic === 'user-text' && participant && !participant.identity.startsWith('bot-')) {
      // User sent text directly (alternative to STT)
      const text = new TextDecoder().decode(payload);
      handleUserText(session, text);
    }
  });

  // --- Connect to room ---
  console.log(`[LiveKit Bot] Connecting to room ${roomName} as ${botIdentity}...`);
  await room.connect(env.livekitWsUrl!, botToken);
  console.log(`[LiveKit Bot] Connected to room ${roomName}`);

  // If session was closed during connect (browser sent /livekit/close), abort early
  if (session.isClosed) {
    console.log(`[LiveKit Bot] Session ${callId} was closed during connect — aborting setup`);
    return { botToken, roomName };
  }

  // --- Publish bot audio track ---
  const audioTrack = LocalAudioTrack.createAudioTrack('bot-audio', audioSource);
  const publishOptions = new TrackPublishOptions();
  publishOptions.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant!.publishTrack(audioTrack, publishOptions);
  console.log(`[LiveKit Bot] Published audio track`);

  // --- Send initial greeting when user joins (not on a blind timer) ---
  // The browser may still be connecting, so we listen for the user participant
  // to actually appear in the room before sending any audio.
  let greetingSent = false;
  const sendGreeting = () => {
    if (greetingSent || session.isClosed) return;
    greetingSent = true;
    console.log(`[LiveKit Bot] User detected in room — sending initial greeting`);
    // Small delay to let the subscription fully establish
    setTimeout(() => handleUserText(session, null), 200);
  };

  // Case A: user already in room (joined before bot)
  const hasUser = Array.from(room.remoteParticipants.values())
    .some((p: RemoteParticipant) => !p.identity.startsWith('bot-'));

  if (hasUser) {
    sendGreeting();
  }

  // Case B: user joins after bot
  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    if (!participant.identity.startsWith('bot-')) {
      console.log(`[LiveKit Bot] User ${participant.identity} joined room`);
      // Cancel any pending disconnect grace timer — user is back
      if (session.disconnectGraceTimer) {
        clearTimeout(session.disconnectGraceTimer);
        session.disconnectGraceTimer = null;
      }
      sendGreeting();
    }
  });

  return { botToken, roomName };
}

/**
 * Handle incoming audio stream from the user.
 * Reads audio frames from a user's remote audio track.
 * Feeds PCM data into the STT push stream and performs basic energy-based VAD.
 */
async function handleRemoteAudioTrack(session: BotSession, track: RemoteTrack): Promise<void> {
  const audioStream = new AudioStream(track, SAMPLE_RATE, NUM_CHANNELS);
  const reader = audioStream.getReader();

  // Start STT on first audio track subscription
  await startStt(session);

  try {
    while (!session.isClosed) {
      const { done, value: frame } = await reader.read();
      if (done || session.isClosed) break;

      // Feed raw PCM into Azure STT push stream
      if (session.sttRecognizer) {
        const int16 = frame.data;
        const arrayBuffer = int16.buffer.slice(
          int16.byteOffset,
          int16.byteOffset + int16.byteLength
        );
        session.sttRecognizer.pushStream.write(arrayBuffer as ArrayBuffer);
      }

      // Energy-based VAD for silence/speech detection (drives reminder timers)
      const energy = calculateEnergy(frame.data);
      const SPEECH_THRESHOLD = 500;

      if (energy > SPEECH_THRESHOLD) {
        if (!session.speechActive) {
          session.speechActive = true;
          clearSilenceTimer(session);
          clearReminderTimer(session);
        }
      } else if (session.speechActive) {
        startSilenceTimer(session);
      }
    }
  } catch (err) {
    if (!session.isClosed) {
      console.error(`[LiveKit Bot] Audio stream error for ${session.callId}:`, err);
    }
  }
}

function calculateEnergy(data: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += Math.abs(data[i]);
  }
  return sum / data.length;
}

function startSilenceTimer(session: BotSession): void {
  clearSilenceTimer(session);
  const state = getConversationState(session.callId);
  const env = loadEnv();
  const silenceMs = getSilenceDurationForStep(state.step, env.turnResponsiveness) * 1000;

  session.silenceTimer = setTimeout(() => {
    if (session.speechActive && !session.isClosed) {
      session.speechActive = false;
      onSpeechEnd(session);
    }
  }, silenceMs);
}

function clearSilenceTimer(session: BotSession): void {
  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
}

function startReminderTimer(session: BotSession): void {
  clearReminderTimer(session);
  const env = loadEnv();
  const reminderMs = env.reminderTriggerMs;

  session.reminderTimer = setTimeout(async () => {
    if (session.isClosed) return;
    const state = getConversationState(session.callId);
    const lang = state.language === 'en' ? 'en' : 'es' as const;
    const reminder = getReminder(state.step, lang);

    if (reminder) {
      await speakText(session, reminder);
      // Restart reminder timer for subsequent reminders
      startReminderTimer(session);
    }
  }, reminderMs);
}

function clearReminderTimer(session: BotSession): void {
  if (session.reminderTimer) {
    clearTimeout(session.reminderTimer);
    session.reminderTimer = null;
  }
}

/**
 * Called when user finishes speaking (silence detected after speech).
 * With STT active, final results come through the recognizer callbacks.
 * This just ensures the reminder timer restarts.
 */
async function onSpeechEnd(session: BotSession): Promise<void> {
  startReminderTimer(session);
}

/**
 * Start server-side Azure Speech-to-Text for the LiveKit bot session.
 * Uses auto-detect (es+en) initially, then restarts with fixed language once confirmed.
 */
async function startStt(session: BotSession, language?: 'es' | 'en'): Promise<void> {
  if (session.isClosed) return;

  // If already running with the right language, skip
  if (session.sttStarted && language && session.sttLanguage === language) return;

  if (!isAzureSttConfigured()) {
    console.warn(`[LiveKit Bot] Azure STT not configured — voice recognition disabled for ${session.callId}`);
    return;
  }

  // Stop existing recognizer if restarting with new language
  if (session.sttRecognizer) {
    try { await session.sttRecognizer.stop(); } catch { /* ignore */ }
    session.sttRecognizer = null;
  }

  const useAutoDetect = !language;
  const lang: 'es' | 'en' = language ?? 'es';
  session.sttLanguage = language ?? 'auto';
  session.sttStarted = true;

  console.log(`[LiveKit Bot] Starting STT (mode=${useAutoDetect ? 'auto-detect' : lang}) for ${session.callId}`);

  session.sttRecognizer = createPushStreamRecognizer({
    language: lang,
    autoDetect: useAutoDetect,
    silenceTimeoutMs: 1000,

    onInterim: (result) => {
      if (session.isClosed) return;
      session.interimText = result.text;
      sendDataMessage(session, { type: 'interim', text: result.text });
    },

    onFinal: async (result) => {
      if (session.isClosed) return;
      const text = result.text.trim();
      if (!text) return;
      session.interimText = '';
      console.log(`[LiveKit Bot] STT final: "${text}" (lang=${result.language}, callId=${session.callId})`);
      sendDataMessage(session, { type: 'transcription', text, isFinal: true });
      await handleUserText(session, text);
    },

    onSilence: () => {
      if (session.isClosed) return;
      if (session.interimText.trim()) {
        const text = session.interimText.trim();
        session.interimText = '';
        console.log(`[LiveKit Bot] STT silence with pending interim: "${text}" (callId=${session.callId})`);
        sendDataMessage(session, { type: 'transcription', text, isFinal: true });
        handleUserText(session, text);
      }
    },

    onError: (error) => {
      console.error(`[LiveKit Bot] STT error for ${session.callId}:`, error.message);
    },
  });

  try {
    await session.sttRecognizer.start();
    console.log(`[LiveKit Bot] STT recognizer started for ${session.callId}`);
  } catch (err) {
    console.error(`[LiveKit Bot] Failed to start STT for ${session.callId}:`, err);
    session.sttRecognizer = null;
    session.sttStarted = false;
  }
}

/**
 * Process a user text input through the dialogue manager and speak the response.
 */
async function handleUserText(session: BotSession, text: string | null): Promise<void> {
  if (session.isClosed) return;

  clearReminderTimer(session);

  try {
    console.log(`[LiveKit Bot] handleUserText called (text=${text === null ? 'null' : `"${text.substring(0, 40)}"`}, callId=${session.callId})`);
    const dialogStart = Date.now();
    const result = await handleUserInput(session.callId, text, async (sentence: string) => {
      // Streaming callback: speak each sentence as it arrives from LLM
      if (!session.isClosed) {
        await speakText(session, sentence);
      }
    });
    console.log(`[LiveKit Bot] handleUserInput returned in ${Date.now() - dialogStart}ms (step=${result.state.step}, reply=${result.replyText?.substring(0, 60) || 'none'})`);

    // ── Auto language switch: notify browser via data channel ──
    if (result.languageChanged) {
      console.log(`[LiveKit Bot] Language auto-switched to '${result.languageChanged}' for ${session.callId}`);
      sendDataMessage(session, { type: 'language-detected', language: result.languageChanged });
      // Restart STT with the confirmed language for better accuracy
      const confirmedLang = result.languageChanged === 'en' ? 'en' as const : 'es' as const;
      if (session.sttLanguage !== confirmedLang) {
        startStt(session, confirmedLang);
      }
    }

    // If streaming didn't fire (non-streaming path), speak the full response
    if (result.replyText) {
      // The streaming onSentence callback handles partial delivery,
      // but if it was never called (non-streaming), speak the full reply
      // We check by looking at whether the reply is different from what was already spoken
      // For simplicity, if onSentence was used, replyText will still contain the full text
      // but it will have already been spoken sentence-by-sentence.
      // To avoid double-speaking, we only speak if the streaming path wasn't used.
      // The manager's llmStepWithStreaming sets replyStream if streaming was used.
      if (!result.replyStream) {
        await speakText(session, result.replyText);
      }
    }

    // Send state update to browser via data channel
    sendDataMessage(session, {
      type: 'state-update',
      state: result.state,
      replyText: result.replyText,
      isFinished: result.isFinished,
    });

    if (result.isFinished) {
      clearConversationState(session.callId);
      sendDataMessage(session, { type: 'session-end' });
      // Give time for the final audio to play, then close
      setTimeout(() => closeBotSession(session.callId), 5000);
    } else {
      setConversationState(session.callId, result.state);
      startReminderTimer(session);
    }
  } catch (err) {
    console.error(`[LiveKit Bot] Error processing text for ${session.callId}:`, err);
  }
}

/**
 * Synthesize text to speech and send audio frames through the bot's audio track.
 * Uses streaming TTS to push frames as they arrive (reducing first-byte latency from ~10s to ~1-2s).
 * Falls back to non-streaming if streaming fails.
 */
async function speakText(session: BotSession, text: string): Promise<void> {
  if (session.isClosed || !text.trim()) return;

  const state = getConversationState(session.callId);
  const lang = state.language === 'en' ? 'en' : 'es' as const;

  try {
    // ── Check greeting cache first — instant playback, no TTS call ──
    const cachedFrames = getCachedGreetingFrames(text);
    if (cachedFrames) {
      const cacheStart = Date.now();
      for (const samples of cachedFrames) {
        if (session.isClosed) break;
        const frame = new AudioFrame(samples, PCM_SAMPLE_RATE, NUM_CHANNELS, SAMPLES_PER_FRAME);
        await session.audioSource.captureFrame(frame);
      }
      console.log(`[LiveKit Bot] Played cached greeting (${cachedFrames.length} frames, ${Date.now() - cacheStart}ms)`);
      return;
    }

    // ── Streaming TTS: push frames as they arrive from Azure ──
    const ttsStart = Date.now();
    const samplesPerFrame = (SAMPLE_RATE * FRAME_SIZE_MS) / 1000; // 320 samples
    const bytesPerFrame = samplesPerFrame * 2; // 16-bit = 2 bytes per sample
    let totalBytes = 0;
    let firstChunkMs = 0;
    let residualBuffer = Buffer.alloc(0); // leftover bytes from previous chunk

    await synthesizeTtsStreaming(text, lang, {
      onAudioChunk: (chunk: Buffer) => {
        if (session.isClosed) return;
        if (!firstChunkMs) {
          firstChunkMs = Date.now() - ttsStart;
          console.log(`[LiveKit Bot] TTS first chunk in ${firstChunkMs}ms`);
        }
        totalBytes += chunk.length;

        // Combine residual with new chunk
        const pcmBuffer = residualBuffer.length > 0
          ? Buffer.concat([residualBuffer, chunk])
          : chunk;

        let offset = 0;
        for (; offset + bytesPerFrame <= pcmBuffer.length; offset += bytesPerFrame) {
          const samples = new Int16Array(samplesPerFrame);
          for (let i = 0; i < samplesPerFrame; i++) {
            samples[i] = pcmBuffer.readInt16LE(offset + i * 2);
          }
          const frame = new AudioFrame(samples, SAMPLE_RATE, NUM_CHANNELS, samplesPerFrame);
          // captureFrame returns a Promise; frames queue in AudioSource and play at real-time rate
          session.audioSource.captureFrame(frame).catch(() => { /* session closed */ });
        }

        // Save leftover bytes for next chunk
        residualBuffer = Buffer.from(pcmBuffer.subarray(offset));
      },
      onComplete: () => {
        // Push any remaining residual bytes as a final padded frame
        if (residualBuffer.length > 0 && !session.isClosed) {
          const samples = new Int16Array(samplesPerFrame);
          for (let i = 0; i < residualBuffer.length / 2 && i < samplesPerFrame; i++) {
            samples[i] = residualBuffer.readInt16LE(i * 2);
          }
          const frame = new AudioFrame(samples, SAMPLE_RATE, NUM_CHANNELS, samplesPerFrame);
          session.audioSource.captureFrame(frame).catch(() => { /* session closed */ });
          residualBuffer = Buffer.alloc(0);
        }
        console.log(`[LiveKit Bot] TTS streaming complete: ${totalBytes} bytes in ${Date.now() - ttsStart}ms (first chunk: ${firstChunkMs}ms)`);
      },
      onError: (error: Error) => {
        console.error(`[LiveKit Bot] TTS streaming error for ${session.callId}:`, error.message);
      },
    }, 'pcm16k');
  } catch (err) {
    console.error(`[LiveKit Bot] TTS error for ${session.callId}:`, err);
  }
}

/**
 * Send a JSON data message to all participants in the room via the data channel.
 */
function sendDataMessage(session: BotSession, data: Record<string, unknown>): void {
  if (session.isClosed || !session.room.localParticipant) return;

  try {
    const payload = new TextEncoder().encode(JSON.stringify(data));
    session.room.localParticipant.publishData(payload, {
      reliable: true,
      topic: 'bot-state',
    });
  } catch (err) {
    console.error(`[LiveKit Bot] Data send error for ${session.callId}:`, err);
  }
}

/**
 * Close a bot session and clean up all resources.
 */
export async function closeBotSession(callId: string): Promise<void> {
  const session = activeSessions.get(callId);
  if (!session || session.isClosed) return;

  session.isClosed = true;
  clearSilenceTimer(session);
  clearReminderTimer(session);
  if (session.disconnectGraceTimer) {
    clearTimeout(session.disconnectGraceTimer);
    session.disconnectGraceTimer = null;
  }

  // Stop STT recognizer
  if (session.sttRecognizer) {
    try {
      await session.sttRecognizer.stop();
      console.log(`[LiveKit Bot] STT stopped for ${callId}`);
    } catch { /* ignore */ }
    session.sttRecognizer = null;
  }

  try {
    await session.audioSource.close();
  } catch { /* ignore */ }

  try {
    await session.room.disconnect();
  } catch { /* ignore */ }

  activeSessions.delete(callId);
  console.log(`[LiveKit Bot] Session ${callId} closed`);
}

/**
 * Get the active session for a callId.
 */
export function getBotSession(callId: string): BotSession | undefined {
  return activeSessions.get(callId);
}

/**
 * Get count of active bot sessions.
 */
export function getActiveBotSessionCount(): number {
  return activeSessions.size;
}
