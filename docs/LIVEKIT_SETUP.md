# Fase 5 - Migracion a WebRTC via LiveKit

## Estado actual (lo que ya existe)

### Scaffolding server-side
- `src/realtime/livekitTransport.ts` - Funciones `isLiveKitConfigured()`, `generateLiveKitToken()`, `selectTransport()`
- `src/server.ts:55-69` - Endpoint `POST /livekit/token` que genera JWT tokens
- `src/config/env.ts` - Variables `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL`
- `.env.example:90-97` - Documentacion de las variables

### Lo que FALTA implementar

---

## Paso 1: Elegir proveedor LiveKit (MANUAL)

**Opcion A: LiveKit Cloud (recomendado para empezar)**
1. Ir a https://cloud.livekit.io
2. Crear cuenta gratuita
3. Crear un proyecto
4. Copiar API Key, API Secret, y WebSocket URL
5. Ponerlos en `.env`:
```
LIVEKIT_API_KEY=APIxxxxxxxxxxxxx
LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LIVEKIT_WS_URL=wss://your-project.livekit.cloud
```

**Opcion B: LiveKit self-hosted**
```bash
# Docker (desarrollo local)
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  -e LIVEKIT_KEYS="devkey: secret" \
  livekit/livekit-server

# .env
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_WS_URL=ws://localhost:7880
```

**RetellAI usa LiveKit Cloud** (`wss://retell-ai-*.livekit.cloud`). Para igualar su setup, LiveKit Cloud es lo mas directo.

---

## Paso 2: Instalar dependencias

```bash
# Server-side SDK (ya referenciado en livekitTransport.ts)
npm install livekit-server-sdk

# Client-side SDK para el browser (cargar via CDN es mas simple)
# No necesita npm install - se carga en el HTML
```

---

## Paso 3: Crear `src/webrtc/botParticipant.ts` (SERVER-SIDE)

Este modulo es el "bot" que se une a la sala de LiveKit como participante del lado servidor. Es el puente entre LiveKit y nuestro pipeline de voz.

```typescript
// src/webrtc/botParticipant.ts
import {
  Room,
  RoomEvent,
  TrackPublishOptions,
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  TrackKind,
} from 'livekit-server-sdk';
// NOTA: livekit-server-sdk v2+ expone agents framework.
// Si no esta disponible, usar @livekit/agents-plugin-node
import { loadEnv } from '../config/env.js';

const env = loadEnv();

interface BotParticipantCallbacks {
  onUserAudio: (pcmData: Buffer) => void;       // Audio del usuario → pipeline STT
  onUserJoined: () => void;
  onUserLeft: () => void;
}

export class BotParticipant {
  private room: Room;
  private audioSource: AudioSource | null = null;
  private callbacks: BotParticipantCallbacks;
  private roomName: string;

  constructor(roomName: string, callbacks: BotParticipantCallbacks) {
    this.roomName = roomName;
    this.room = new Room();
    this.callbacks = callbacks;
  }

  async join(token: string): Promise<void> {
    // Subscribirse a tracks remotos (audio del usuario)
    this.room.on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed.bind(this));
    this.room.on(RoomEvent.ParticipantConnected, () => this.callbacks.onUserJoined());
    this.room.on(RoomEvent.ParticipantDisconnected, () => this.callbacks.onUserLeft());

    await this.room.connect(env.livekitWsUrl!, token);

    // Crear audio source para publicar audio del bot (TTS)
    this.audioSource = new AudioSource(24000, 1); // 24kHz mono para Voice Live TTS
    const track = LocalAudioTrack.createAudioTrack('bot_audio', this.audioSource);
    await this.room.localParticipant.publishTrack(track, {
      name: 'agent_audio', // Nombre que RetellAI usa para su agent track
    } as TrackPublishOptions);
  }

  /** Enviar audio PCM del bot (TTS output) al usuario via WebRTC */
  async pushAudio(pcmInt16: Buffer): Promise<void> {
    if (!this.audioSource) return;
    // Convertir Int16 buffer a AudioFrame
    const samples = new Int16Array(
      pcmInt16.buffer,
      pcmInt16.byteOffset,
      pcmInt16.byteLength / 2
    );
    const frame = new AudioFrame(samples, 24000, 1, samples.length);
    await this.audioSource.captureFrame(frame);
  }

  async leave(): Promise<void> {
    await this.room.disconnect();
  }

  private handleTrackSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    if (track.kind !== TrackKind.KIND_AUDIO) return;

    // Stream audio del usuario
    const audioStream = new AudioStream(track);
    (async () => {
      for await (const frame of audioStream) {
        // Convertir AudioFrame a Buffer PCM Int16
        const pcmBuffer = Buffer.from(frame.data.buffer);
        this.callbacks.onUserAudio(pcmBuffer);
      }
    })();
  }
}
```

**NOTA IMPORTANTE**: El API de `livekit-server-sdk` para Node.js cambia frecuentemente entre versiones. Los imports arriba son para la version v2+ con agents framework. Verifica la documentacion actual en:
- https://docs.livekit.io/agents/quickstarts/node/
- https://github.com/livekit/agents-js

---

## Paso 4: Integrar BotParticipant en el flujo de sesion

En `voiceWebSocket.ts`, cuando el transporte es LiveKit:

1. Al crear la sesion (`handleInit`):
   - Generar room name: `voice-${sessionId}`
   - Generar token para el bot via `generateLiveKitToken(roomName, 'bot')`
   - Crear `BotParticipant` y hacer `join(token)`
   - Configurar callbacks: `onUserAudio` → pipe a Voice Live / Azure STT

2. En vez de recibir audio por WebSocket binary frames:
   - El audio del usuario llega via `onUserAudio` callback del BotParticipant
   - Ese audio se pipa directamente a `session.vlClient.sendAudio()` o al Azure STT recognizer

3. En vez de enviar audio por `send(ws, { type: 'audio', audioBase64 })`:
   - Llamar `botParticipant.pushAudio(pcmBuffer)` para publicar en el track de LiveKit
   - El WebSocket se mantiene SOLO para mensajes de control (state, transcripts, clear)

4. Al terminar la sesion (`cleanupSession`):
   - Llamar `botParticipant.leave()`

---

## Paso 5: Agregar LiveKit client SDK al browser

En `public/voice-test-v2.html`:

```html
<!-- Agregar antes del <script> principal -->
<script src="https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.js"></script>
```

Nueva funcion `connectWebRTC()`:

```javascript
var livekitRoom = null;

async function connectWebRTC() {
  // 1. Obtener token del server
  var resp = await fetch('/livekit/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomName: 'voice-' + sessionId,
      identity: 'user-' + sessionId,
    }),
  });
  var data = await resp.json();

  // 2. Conectar a la room
  livekitRoom = new LivekitClient.Room({
    audioCaptureDefaults: {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    },
  });

  // 3. Subscribirse al audio del bot
  livekitRoom.on(LivekitClient.RoomEvent.TrackSubscribed, function(track, pub, participant) {
    if (track.kind === 'audio' && participant.identity === 'bot') {
      var audioEl = track.attach();
      document.body.appendChild(audioEl);
      audioEl.play();
    }
  });

  // 4. Conectar y habilitar microfono
  await livekitRoom.connect(data.wsUrl, data.token);
  await livekitRoom.localParticipant.setMicrophoneEnabled(true);

  log('WebRTC conectado via LiveKit', 'ok');
}
```

En `startRecording()`, si LiveKit esta disponible:
```javascript
if (livekitRoom) {
  // Audio ya fluye por WebRTC — no necesitamos captura manual
  isRecording = true;
  setMicState('listening');
  return;
}
// ... fallback a AudioWorklet/ScriptProcessor actual
```

El audio del bot llega automaticamente por el track subscrito — no necesitas `playAudio()` para la ruta WebRTC.

---

## Paso 6: Data channel para mensajes de control (opcional)

LiveKit soporta data channels confiables. Puedes migrar los mensajes JSON (state, transcripts, clear) del WebSocket al data channel de LiveKit:

```javascript
// Browser: enviar texto
livekitRoom.localParticipant.publishData(
  new TextEncoder().encode(JSON.stringify({ type: 'text', data: { text: 'hola' } })),
  { reliable: true }
);

// Browser: recibir
livekitRoom.on(LivekitClient.RoomEvent.DataReceived, function(payload, participant) {
  var msg = JSON.parse(new TextDecoder().decode(payload));
  handleServerMessage(msg);
});
```

Con esto el WebSocket se vuelve completamente innecesario. Pero para esta fase inicial, mantener WebSocket para control + LiveKit para audio es mas seguro.

---

## Arquitectura final (3 canales)

```
Browser ←── WebRTC audio (UDP, low-latency) ──→ LiveKit SFU ←── BotParticipant (server)
                                                                  │
                                                                  ├── User Audio → Voice Live STT / Azure STT
                                                                  ├── Transcription → Dialogue Manager
                                                                  ├── Reply Text → LLM → TTS (streaming)
                                                                  └── TTS Audio → publish audio track

Browser ←── WebSocket (TCP, reliable) ──→ Server
             Solo mensajes de control:
             - state (sessionId, speaking, listening)
             - interim / final (transcripciones)
             - clear (flush audio en barge-in)
             - finished (call ended)
```

---

## Fallback automatico

El sistema actual en `livekitTransport.ts` ya detecta si LiveKit esta configurado:
- Si `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` + `LIVEKIT_WS_URL` estan presentes Y `livekit-server-sdk` esta instalado → usa LiveKit
- Si no → fallback automatico a WebSocket (ruta actual, sin cambios)

`selectTransport()` en `livekitTransport.ts` ya implementa esta logica. El browser debe verificar `/health` endpoint que reporta `transport: 'livekit' | 'websocket'` para decidir que ruta usar.

---

## Comparacion con RetellAI

| Aspecto | RetellAI | Nuestro sistema (post-LiveKit) |
|---------|----------|-------------------------------|
| Transport | LiveKit Cloud | LiveKit Cloud/self-hosted |
| Audio format | Opus via WebRTC | Opus via WebRTC |
| Latency | < 50ms transport | < 50ms transport |
| Echo cancellation | LiveKit built-in | LiveKit built-in |
| Noise suppression | Server-side + client | Client-side + Voice Live |
| Data channel | Transcripts via LiveKit data | WebSocket (migratable) |
| Bot identity | "server" participant | "bot" participant |

---

## Checklist de verificacion

- [ ] LiveKit Cloud/self-hosted corriendo y accesible
- [ ] `npm install livekit-server-sdk` exitoso
- [ ] `.env` con LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WS_URL
- [ ] `POST /livekit/token` devuelve token valido
- [ ] `src/webrtc/botParticipant.ts` creado y compila
- [ ] Bot se une a la room y publica audio track
- [ ] Browser se conecta via LiveKit SDK y escucha audio del bot
- [ ] Mic del browser fluye por WebRTC al bot → Voice Live/Azure STT
- [ ] Fallback a WebSocket funciona cuando LiveKit no esta configurado
- [ ] Medir latencia round-trip: target < 200ms (audio transport only)
