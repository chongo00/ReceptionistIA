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
import { synthesizeTts } from '../tts/ttsProvider.js';
import { getSilenceDurationForStep } from '../dialogue/turnTaking.js';
import { getReminder } from '../dialogue/humanizer.js';

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
    // If the user leaves, close the session
    if (!participant.identity.startsWith('bot-')) {
      closeBotSession(callId);
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

  // --- Publish bot audio track ---
  const audioTrack = LocalAudioTrack.createAudioTrack('bot-audio', audioSource);
  const publishOptions = new TrackPublishOptions();
  publishOptions.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant!.publishTrack(audioTrack, publishOptions);
  console.log(`[LiveKit Bot] Published audio track`);

  // --- Send initial greeting ---
  // Small delay to let the user's client subscribe to tracks
  setTimeout(() => {
    handleUserText(session, null);
  }, 500);

  return { botToken, roomName };
}

/**
 * Handle incoming audio stream from the user.
 * Accumulates frames and performs very basic energy-based VAD.
 */
async function handleRemoteAudioTrack(session: BotSession, track: RemoteTrack): Promise<void> {
  const audioStream = new AudioStream(track, SAMPLE_RATE, NUM_CHANNELS);
  const reader = audioStream.getReader();

  try {
    while (!session.isClosed) {
      const { done, value: frame } = await reader.read();
      if (done || session.isClosed) break;

      const energy = calculateEnergy(frame.data);
      const SPEECH_THRESHOLD = 500;

      if (energy > SPEECH_THRESHOLD) {
        if (!session.speechActive) {
          session.speechActive = true;
          session.audioBuffer = [];
          clearSilenceTimer(session);
          clearReminderTimer(session);
        }
        session.audioBuffer.push(new Int16Array(frame.data));
      } else if (session.speechActive) {
        // Silence after speech — start end-of-speech timer
        session.audioBuffer.push(new Int16Array(frame.data));
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
 * The accumulated audio buffer is NOT used for STT here (LiveKit doesn't bundle STT).
 * Instead, we rely on the browser-side STT or a separate STT service.
 *
 * For now, this is the hook where external STT results would arrive.
 * The primary path is via DataReceived ('user-text' topic).
 */
async function onSpeechEnd(session: BotSession): Promise<void> {
  // Audio buffer accumulated but user text comes through DataReceive channel
  // Start reminder timer while waiting for next user input
  startReminderTimer(session);
}

/**
 * Process a user text input through the dialogue manager and speak the response.
 */
async function handleUserText(session: BotSession, text: string | null): Promise<void> {
  if (session.isClosed) return;

  clearReminderTimer(session);

  try {
    const result = await handleUserInput(session.callId, text, async (sentence: string) => {
      // Streaming callback: speak each sentence as it arrives from LLM
      if (!session.isClosed) {
        await speakText(session, sentence);
      }
    });

    // ── Auto language switch: notify browser via data channel ──
    if (result.languageChanged) {
      console.log(`[LiveKit Bot] Language auto-switched to '${result.languageChanged}' for ${session.callId}`);
      sendDataMessage(session, { type: 'language-detected', language: result.languageChanged });
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
 */
async function speakText(session: BotSession, text: string): Promise<void> {
  if (session.isClosed || !text.trim()) return;

  const state = getConversationState(session.callId);
  const lang = state.language === 'en' ? 'en' : 'es' as const;

  try {
    const ttsResult = await synthesizeTts(text, lang, 'pcm16k');
    if (!ttsResult) return;

    // TTS returns audio as a Buffer. We need to convert to PCM Int16 frames.
    // Azure TTS with pcm format returns raw PCM 16-bit signed LE mono 16kHz
    const pcmBuffer = ttsResult.bytes;
    const samplesPerFrame = (SAMPLE_RATE * FRAME_SIZE_MS) / 1000; // 320 samples
    const bytesPerFrame = samplesPerFrame * 2; // 16-bit = 2 bytes per sample

    for (let offset = 0; offset < pcmBuffer.length; offset += bytesPerFrame) {
      if (session.isClosed) break;

      const end = Math.min(offset + bytesPerFrame, pcmBuffer.length);
      const chunkLength = end - offset;
      const samples = new Int16Array(samplesPerFrame);

      // Copy PCM data (little-endian Int16)
      for (let i = 0; i < chunkLength / 2 && i < samplesPerFrame; i++) {
        samples[i] = pcmBuffer.readInt16LE(offset + i * 2);
      }

      const frame = new AudioFrame(samples, SAMPLE_RATE, NUM_CHANNELS, samplesPerFrame);
      await session.audioSource.captureFrame(frame);
    }
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
