// ── Voice Live API protocol types ──────────────────────────────────
// Based on Azure OpenAI Realtime API events reference + Voice Live extensions.
// See: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to

// ── Client → Server events ──

export interface SessionConfig {
  instructions?: string;
  turn_detection?: TurnDetectionConfig;
  input_audio_noise_reduction?: { type: 'azure_deep_noise_suppression' };
  input_audio_echo_cancellation?: { type: 'server_echo_cancellation' };
  input_audio_sampling_rate?: 16000 | 24000;
  voice?: VoiceConfig;
  modalities?: ('text' | 'audio')[];
  input_audio_transcription?: { model: string; language: string };
}

export interface TurnDetectionConfig {
  type: 'azure_semantic_vad' | 'azure_semantic_vad_multilingual' | 'server_vad';
  create_response?: boolean;
  silence_duration_ms?: number;
  languages?: string[];
  remove_filler_words?: boolean;
  interrupt_response?: boolean;
}

export interface VoiceConfig {
  name: string;
  type: 'azure-standard' | 'azure-custom';
  temperature?: number;
  rate?: string;
}

export interface SessionUpdateEvent {
  type: 'session.update';
  session: SessionConfig;
}

export interface InputAudioAppendEvent {
  type: 'input_audio_buffer.append';
  audio: string; // base64 PCM
}

export interface InputAudioClearEvent {
  type: 'input_audio_buffer.clear';
}

export interface InputAudioCommitEvent {
  type: 'input_audio_buffer.commit';
}

export interface ConversationItemCreateEvent {
  type: 'conversation.item.create';
  item: {
    type: 'message';
    role: 'user' | 'assistant';
    content: Array<{ type: 'text' | 'input_text'; text: string }>;
  };
}

export interface ResponseCreateEvent {
  type: 'response.create';
  response?: {
    modalities?: ('text' | 'audio')[];
    instructions?: string;
  };
}

export interface ResponseCancelEvent {
  type: 'response.cancel';
}

export type ClientEvent =
  | SessionUpdateEvent
  | InputAudioAppendEvent
  | InputAudioClearEvent
  | InputAudioCommitEvent
  | ConversationItemCreateEvent
  | ResponseCreateEvent
  | ResponseCancelEvent;

// ── Server → Client events ──

export interface SessionCreatedEvent {
  type: 'session.created';
  session: Record<string, unknown>;
}

export interface SessionUpdatedEvent {
  type: 'session.updated';
  session: Record<string, unknown>;
}

export interface SpeechStartedEvent {
  type: 'input_audio_buffer.speech_started';
  audio_start_ms: number;
  item_id: string;
}

export interface SpeechStoppedEvent {
  type: 'input_audio_buffer.speech_stopped';
  audio_end_ms: number;
  item_id: string;
}

export interface TranscriptionCompletedEvent {
  type: 'conversation.item.input_audio_transcription.completed';
  item_id: string;
  content_index: number;
  transcript: string;
}

export interface AudioDeltaEvent {
  type: 'response.audio.delta';
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string; // base64 PCM audio
}

export interface AudioDoneEvent {
  type: 'response.audio.done';
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
}

export interface AudioTranscriptDeltaEvent {
  type: 'response.audio_transcript.delta';
  response_id: string;
  delta: string;
}

export interface AudioTranscriptDoneEvent {
  type: 'response.audio_transcript.done';
  response_id: string;
}

export interface ResponseCreatedEvent {
  type: 'response.created';
  response: Record<string, unknown>;
}

export interface ResponseDoneEvent {
  type: 'response.done';
  response: Record<string, unknown>;
}

export interface VoiceLiveErrorEvent {
  type: 'error';
  error: { type: string; code: string; message: string };
}

export interface ConversationItemCreatedEvent {
  type: 'conversation.item.created';
  previous_item_id: string;
  item: Record<string, unknown>;
}

export type ServerEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SpeechStartedEvent
  | SpeechStoppedEvent
  | TranscriptionCompletedEvent
  | AudioDeltaEvent
  | AudioDoneEvent
  | AudioTranscriptDeltaEvent
  | AudioTranscriptDoneEvent
  | ResponseCreatedEvent
  | ResponseDoneEvent
  | VoiceLiveErrorEvent
  | ConversationItemCreatedEvent;
