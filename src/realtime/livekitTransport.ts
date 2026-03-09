/**
 * LiveKit integration module — provides WebRTC transport as an alternative to raw WebSocket.
 *
 * Architecture: 3-channel model
 *  - Audio track:   Low-latency PCM audio (mic → server, server → speaker)
 *  - Data channel:  Reliable JSON messages (state, transcripts, etc.)
 *  - Control:       LiveKit room events (participant join/leave, track subscribe)
 *
 * When LiveKit is not configured, the system falls back to the existing WebSocket transport.
 */

import { loadEnv } from '../config/env.js';
import { createRequire } from 'module';

let _livekitAvailable: boolean | null = null;

/**
 * Check if LiveKit SDK is installed and configured.
 * Returns false if the dependency is missing or env vars are not set.
 */
export function isLiveKitConfigured(): boolean {
  if (_livekitAvailable !== null) return _livekitAvailable;

  const env = loadEnv();
  if (!env.livekitApiKey || !env.livekitApiSecret || !env.livekitWsUrl) {
    _livekitAvailable = false;
    return false;
  }

  try {
    // Dynamic require check — livekit-server-sdk is an optional dependency
    const require = createRequire(import.meta.url);
    require.resolve('livekit-server-sdk');
    _livekitAvailable = true;
  } catch {
    console.warn('[LiveKit] livekit-server-sdk not installed — falling back to WebSocket transport');
    _livekitAvailable = false;
  }

  return _livekitAvailable;
}

/**
 * Generate a LiveKit access token for a participant.
 * Only call this if isLiveKitConfigured() returns true.
 */
export async function generateLiveKitToken(
  roomName: string,
  participantIdentity: string,
): Promise<string> {
  // Fully dynamic import to avoid TS compile errors when SDK is not installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const livekit: any = await import('livekit-server-sdk');
  const AccessToken = livekit.AccessToken;
  const env = loadEnv();

  const token = new AccessToken(env.livekitApiKey!, env.livekitApiSecret!, {
    identity: participantIdentity,
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return await token.toJwt();
}

/**
 * Determine the best transport for a new voice session.
 * Returns 'livekit' if configured and available, otherwise 'websocket'.
 */
export function selectTransport(): 'livekit' | 'websocket' {
  return isLiveKitConfigured() ? 'livekit' : 'websocket';
}
