import WebSocket from 'ws';
import type {
  SessionConfig,
  ClientEvent,
  ServerEvent,
  AudioDeltaEvent,
  AudioDoneEvent,
  AudioTranscriptDeltaEvent,
  TranscriptionCompletedEvent,
  ResponseCreatedEvent,
  ResponseDoneEvent,
  VoiceLiveErrorEvent,
} from './types.js';

export interface VoiceLiveCallbacks {
  onSessionCreated: () => void;
  onSessionUpdated: () => void;
  onSpeechStarted: () => void;
  onSpeechStopped: () => void;
  onTranscriptionCompleted: (text: string) => void;
  onAudioDelta: (base64Audio: string, responseId: string) => void;
  onAudioDone: (responseId: string) => void;
  onAudioTranscriptDelta: (text: string) => void;
  onResponseDone: (responseId: string) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

const CONNECT_TIMEOUT_MS = 10_000;

export class VoiceLiveClient {
  private ws: WebSocket | null = null;
  private callbacks: VoiceLiveCallbacks;
  private _connected = false;
  private _sessionReady = false;
  private connectStartMs = 0;
  private _currentResponseId: string | null = null;

  constructor(callbacks: VoiceLiveCallbacks) {
    this.callbacks = callbacks;
  }

  get connected(): boolean { return this._connected; }
  get sessionReady(): boolean { return this._sessionReady; }
  get currentResponseId(): string | null { return this._currentResponseId; }

  /**
   * Open WebSocket to Voice Live API.
   * Resolves once session.created is received.
   */
  async connect(
    endpoint: string,
    apiKey: string,
    model: string,
    apiVersion: string,
  ): Promise<void> {
    // Normalize: Voice Live requires wss:// (WebSocket). If user pasted https from portal, convert.
    let base = endpoint.trim().replace(/\/+$/, '');
    if (base.startsWith('https://')) base = 'wss://' + base.slice(8);
    else if (!base.startsWith('wss://')) base = 'wss://' + base;

    // Include api-key as query param (supported by Azure) AND as headers for maximum compatibility
    const url = `${base}/voice-live/realtime?api-version=${apiVersion}&model=${encodeURIComponent(model)}&api-key=${encodeURIComponent(apiKey)}`;

    this.connectStartMs = Date.now();
    console.log(`[VoiceLive] Connecting to ${url.replace(/api-key=[^&]+/g, 'api-key=***')}`);

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this._connected = false;
        const err = new Error(`Voice Live connection timeout (${CONNECT_TIMEOUT_MS}ms). Check VOICE_LIVE_ENDPOINT: for Azure Speech use wss://<resource-name>.cognitiveservices.azure.com (see docs).`);
        console.error('[VoiceLive]', err.message);
        this.callbacks.onError(err);
        reject(err);
      }, CONNECT_TIMEOUT_MS);

      this.ws = new WebSocket(url, {
        headers: {
          'api-key': apiKey,
          'Ocp-Apim-Subscription-Key': apiKey,
        },
      });

      this.ws.on('open', () => {
        this._connected = true;
        const elapsed = Date.now() - this.connectStartMs;
        console.log(`[VoiceLive] WebSocket connected (t_connect=${elapsed}ms)`);
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const event = JSON.parse(data.toString()) as ServerEvent;

          // Resolve the connect() promise on session.created
          if (event.type === 'session.created') {
            if (!resolved) { clearTimeout(timeout); resolved = true; }
            this._sessionReady = true;
            const elapsed = Date.now() - this.connectStartMs;
            console.log(`[VoiceLive] Session created (t_session=${elapsed}ms)`);
            this.callbacks.onSessionCreated();
            resolve();
          }

          this.handleEvent(event);
        } catch (err) {
          console.error('[VoiceLive] Failed to parse server event:', err);
        }
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || '';
        console.log(`[VoiceLive] WebSocket closed: code=${code} reason=${reasonStr}`);
        this._connected = false;
        this._sessionReady = false;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const err = new Error(`Voice Live closed before session (code=${code} reason=${reasonStr}). For Azure Speech use wss://<resource-name>.cognitiveservices.azure.com — not the regional URL.`);
          console.error('[VoiceLive]', err.message);
          this.callbacks.onError(err);
          reject(err);
        }
        this.callbacks.onClose();
      });

      this.ws.on('error', (err) => {
        if (!resolved) { resolved = true; clearTimeout(timeout); }
        this._connected = false;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[VoiceLive] WebSocket error:', msg);
        this.callbacks.onError(err instanceof Error ? err : new Error(msg));
        reject(err);
      });
    });
  }

  /** Configure the Voice Live session (STT, TTS, VAD, voice, etc.). */
  sendSessionUpdate(config: SessionConfig): void {
    this.sendEvent({
      type: 'session.update',
      session: config,
    });
  }

  /** Forward PCM audio (base64-encoded) to Voice Live input buffer. */
  sendAudio(base64Pcm: string): void {
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: base64Pcm,
    });
  }

  /** Clear the input audio buffer (e.g., on barge-in or reset). */
  clearAudioBuffer(): void {
    this.sendEvent({ type: 'input_audio_buffer.clear' });
  }

  /**
   * Inject our response text and trigger Voice Live TTS.
   *
   * Uses conversation.item.create to inject the exact text as an assistant
   * message, then response.create with audio-only modality to synthesize it.
   * This avoids the unreliable "repeat after me" hack where the LLM could
   * paraphrase, add preambles, or truncate the text.
   */
  speakText(text: string): void {
    // Step 1: Inject the exact text as an assistant message in the conversation
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    });

    // Step 2: Trigger TTS-only response to synthesize the injected text
    this.sendEvent({
      type: 'response.create',
      response: {
        modalities: ['audio'],
      },
    });
  }

  /**
   * Speak a single sentence via Voice Live TTS.
   * Creates a conversation item + triggers response for just that sentence.
   * Used by the streaming pipeline to send sentences as they arrive from LLM.
   */
  speakSentence(sentence: string): void {
    this.speakText(sentence);
  }

  /** Cancel an in-progress response (barge-in). */
  cancelResponse(): void {
    this.sendEvent({ type: 'response.cancel' });
  }

  /** Close the WebSocket connection. */
  close(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client closing');
      } catch { /* already closed */ }
      this.ws = null;
    }
    this._connected = false;
    this._sessionReady = false;
  }

  // ── Private ──

  private sendEvent(event: ClientEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'session.created':
        // Already handled in connect() promise
        break;

      case 'session.updated':
        console.log('[VoiceLive] Session updated');
        this.callbacks.onSessionUpdated();
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[VoiceLive] Speech started');
        this.callbacks.onSpeechStarted();
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[VoiceLive] Speech stopped');
        this.callbacks.onSpeechStopped();
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = (event as TranscriptionCompletedEvent).transcript;
        console.log(`[VoiceLive] Transcription: "${transcript}"`);
        this.callbacks.onTranscriptionCompleted(transcript);
        break;
      }

      case 'response.created': {
        const respId = (event as ResponseCreatedEvent).response?.id as string | undefined;
        if (respId) this._currentResponseId = respId;
        break;
      }

      case 'response.audio.delta': {
        const audioDelta = event as AudioDeltaEvent;
        this.callbacks.onAudioDelta(audioDelta.delta, audioDelta.response_id);
        break;
      }

      case 'response.audio.done': {
        const audioDone = event as AudioDoneEvent;
        this.callbacks.onAudioDone(audioDone.response_id);
        break;
      }

      case 'response.audio_transcript.delta':
        this.callbacks.onAudioTranscriptDelta((event as AudioTranscriptDeltaEvent).delta);
        break;

      case 'response.done': {
        const respDone = event as ResponseDoneEvent;
        const respDoneId = (respDone.response as { id?: string })?.id || this._currentResponseId || '';
        console.log(`[VoiceLive] Response complete (id=${respDoneId})`);
        this._currentResponseId = null;
        this.callbacks.onResponseDone(respDoneId);
        break;
      }

      case 'error': {
        const errMsg = (event as VoiceLiveErrorEvent).error?.message || 'Unknown Voice Live error';
        console.error(`[VoiceLive] Error: ${errMsg}`);
        this.callbacks.onError(new Error(errMsg));
        break;
      }

      default:
        // Log unhandled events at debug level
        console.log(`[VoiceLive] Event: ${(event as { type: string }).type}`);
        break;
    }
  }
}
