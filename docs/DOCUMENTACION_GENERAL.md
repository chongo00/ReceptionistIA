# Receptionist IA — Documentacion General

Documentacion tecnica completa del sistema de recepcionista telefonica inteligente de BlindsBook.

---

## 1. Vision general

Receptionist IA es un servicio Node.js/TypeScript que actua como **agente de call center automatizado** para BlindsBook. El sistema:

- Recibe llamadas telefonicas via **Azure Communication Services (ACS)** + **Azure AI Voice Live API** o conexiones WebSocket en tiempo real
- Identifica al cliente automaticamente por Caller ID, nombre o telefono
- Gestiona conversaciones bilingues (espanol/ingles) con voz neuronal
- Crea citas (quotes, instalaciones, reparaciones) directamente en la API de BlindsBook
- Soporta multiples llamadas simultaneas con aislamiento completo por sesion
- Tambien expone un endpoint OCR para deteccion de marcos de ventana (Drapery Calculator)

### Servicios externos utilizados

| Servicio | Funcion | Requerido |
|----------|---------|-----------|
| **Azure OpenAI** (gpt-4o-mini) | LLM principal — comprension conversacional y tool calling | Si |
| **Azure Speech SDK** | STT (Speech-to-Text) + TTS (Text-to-Speech) neuronal | Si |
| **Azure Communication Services (ACS)** | Telefonia — recibe llamadas reales via Voice Live API | Produccion |
| **API BlindsBook** | Backend — clientes, citas, usuarios, equipo | Si |

---

## 2. Arquitectura

```
    Llamada telefonica          Navegador (voice-test-v2)         Drapery Calculator App
          |                              |                                |
    ACS Call Automation          WebSocket /ws/voice               POST /ocr/window-frame
    + Voice Live API                     |                                |
          |                              |                                |
    ┌─────┴──────────────── Express (puerto 4000) ────────────────────────┐
    |                                                                      |
    |  ┌─────────────────────────────────────┐    ┌──────────────────────┐ |
    |  |       Voice WebSocket Handler       |    |   OCR Controller     | |
    |  |  - Sesiones concurrentes (max 20)   |    |  - Azure Vision      | |
    |  |  - Azure STT (speech-to-text)       |    |  - Sharp (edges)     | |
    |  |  - Azure TTS (text-to-speech)       |    └──────────────────────┘ |
    |  |  - Rate limiting TTS (max 15)       |                             |
    |  |  - Barge-in y control de turnos     |                             |
    |  └────────────┬────────────────────────┘                             |
    |               |                                                      |
    |  ┌────────────┴────────────────────────┐                             |
    |  |        Dialogue Manager             |                             |
    |  |  - Maquina de estados por llamada   |                             |
    |  |  - Identificacion (3 niveles)       |                             |
    |  |  - LLM conversacional (Azure)       |                             |
    |  |  - Parser de fechas (chrono-node)   |                             |
    |  |  - Humanizer (SSML + frases)        |                             |
    |  └────────────┬────────────────────────┘                             |
    |               |                                                      |
    |  ┌────────────┴────────────────────────┐                             |
    |  |    BlindsBook API Client            |                             |
    |  |  - TokenManager (multi-tenant)      |                             |
    |  |  - Switch-company (superusuario)    |                             |
    |  |  - Cache de busquedas (5 min)       |                             |
    |  |  - Endpoints optimizados            |                             |
    |  └─────────────────────────────────────┘                             |
    └──────────────────────────────────────────────────────────────────────┘
```

### Multi-tenant

El sistema soporta multiples empresas en un mismo servidor. Cada numero telefonico (ACS) se mapea a una compania en la API de BlindsBook:

```
PHONE_TO_COMPANY_MAP={"+15550001":{"companyId":2},"+15550002":{"companyId":163}}
```

El `TokenManager` se autentica automaticamente como superusuario y usa `POST /auth/switch-company` para obtener tokens JWT por empresa, renovandolos proactivamente cada 30 minutos.

---

## 3. Estructura del proyecto

```
Receptionist IA/
├── src/
│   ├── index.ts                         # Punto de entrada (dotenv + startServer)
│   ├── server.ts                        # Express + HTTP server + graceful shutdown
│   ├── config/
│   │   └── env.ts                       # Variables de entorno (EnvConfig)
│   ├── realtime/
│   │   └── voiceWebSocket.ts            # WebSocket server para voz en tiempo real
│   ├── dialogue/
│   │   ├── state.ts                     # ConversationState, ConversationStep, CustomerMatch
│   │   ├── manager.ts                   # Maquina de estados principal (handleUserInput)
│   │   ├── conversationalLlm.ts         # Prompts del LLM conversacional por paso
│   │   ├── dateParser.ts                # Parser de fechas naturales (chrono-node)
│   │   └── humanizer.ts                 # Frases naturales ES/EN + enriquecimiento SSML
│   ├── stt/
│   │   └── azureSpeechStt.ts            # Speech-to-Text (Azure Speech SDK, push stream)
│   ├── tts/
│   │   ├── azureSpeechSdkTts.ts         # TTS principal (Azure Speech SDK, streaming por frase)
│   │   ├── azureNeuralTts.ts            # TTS via REST API (fallback)
│   │   ├── ttsProvider.ts               # Selector de TTS: SDK > REST > none
│   │   └── ttsCache.ts                  # Cache temporal de MP3 (TTL configurable)
│   ├── llm/
│   │   ├── llmClient.ts                 # Selector LLM: Azure OpenAI (unico proveedor)
│   │   ├── azureOpenaiClient.ts         # Cliente Azure OpenAI (chat + tool calling)
│   │   ├── identificationAgent.ts       # Agente LLM nivel 3 (tool calling multi-turno)
│   │   └── types.ts                     # Tipos: ChatMessage, ToolCall, ToolDefinition
│   ├── blindsbook/
│   │   ├── appointmentsClient.ts        # Cliente API: clientes, citas, busquedas, team
│   │   └── tokenManager.ts             # Gestion de tokens JWT multi-tenant + switch-company

│   ├── ocr/
│   │   ├── windowFrameDetector.ts       # Deteccion de marcos (Sharp + Laplaciano)
│   │   └── azureVisionOcr.ts           # OCR con Azure OpenAI Vision (GPT-4o)
│   └── models/
│       └── appointments.ts              # Tipos: AppointmentType, CreateAppointmentPayload
├── public/
│   ├── voice-test-v2.html               # Simulador de llamada WebSocket (solo dev)
│   └── mic-test.html                    # Diagnostico de microfono
├── scripts/
│   ├── test_chat.ps1                    # Script PowerShell para pruebas de chat
│   ├── check-appointments.cjs           # Verificacion de citas creadas
│   └── validar_citas.sql               # Query SQL para validar citas
├── docs/
│   ├── DOCUMENTACION_GENERAL.md         # Este documento
│   ├── GUIA_PRUEBAS_MANUALES.md        # Guiones de pruebas de voz paso a paso
│   ├── CONVERSATIONAL_STYLE.md          # Tabla de frases y reglas de estilo
│   ├── VOICE_WEBSOCKET_PROTOCOL.md      # Protocolo WebSocket /ws/voice
│   ├── ACS_VOICE_LIVE_INTEGRATION.md    # Plan de integracion ACS + Voice Live
│   └── PLAN_VOICE_AGENT_ACS_VOICE_LIVE.md # Plan de fases del agente de voz
├── Dockerfile                           # Imagen basica Node.js
├── Dockerfile.cloud                     # Imagen multi-stage produccion (~200MB)
├── docker-compose.yml                   # Orquestacion Docker local
├── package.json
├── tsconfig.json
└── .env.example                         # Plantilla de variables de entorno
```

---

## 4. Flujo conversacional

### 4.1 Maquina de estados

El dialogo sigue una maquina de estados definida en `src/dialogue/state.ts`:

```
askLanguage
    │
    ├── "1" / "espanol" → language=es
    └── "2" / "english" → language=en
           │
    identifyByCallerId ─── (tiene callerPhone?)
           │                    │
           │ No                 │ Si → busca por telefono
           │                    │
           │              ┌─────┴──────┐
           │              │ 1 match    │ N matches    │ 0 matches
           │              │            │              │
           │              greeting  disambiguate   askCustomerName
           │                           │              │
           │                           │         confirmCustomerIdentity
           │                           │              │
           │                           │         (3 intentos fallidos?)
           │                           │              │
           │                           │         llmFallback (Azure OpenAI tool calling)
           │                           │
    greeting ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
        │
    askType → (cotizacion / instalacion / reparacion)
        │
    askDate → (fecha en lenguaje natural: "manana", "el lunes", "3 de marzo")
        │
    askTime → (hora: "a las 3", "3pm")  ← se salta si la fecha incluyo hora
        │
    askDuration → (1 hora estandar, o personalizada)
        │
    confirmSummary → (resumen completo de la cita)
        │
    ├── "no" → vuelve a askType (conserva datos del cliente)
    └── "si" → creatingAppointment → POST /appointments
                    │
                completed → (despedida)
```

### 4.2 Identificacion de cliente (3 niveles)

| Nivel | Mecanismo | Tiempo tipico | Uso |
|-------|-----------|---------------|-----|
| 1 | **Caller ID** — busca por telefono automaticamente | ~3s | ~60% de las llamadas |
| 2 | **Nombre/telefono** — el cliente lo dice verbalmente | ~2s | ~30% de las llamadas |
| 3 | **LLM Agent (Azure OpenAI)** — tool calling contra la API | ~5s | ~10% casos complejos |

La busqueda de clientes usa el endpoint optimizado `GET /customers/quick-search` de la API BlindsBook, con normalizacion de telefono (elimina codigo de pais +1) y cache en memoria (TTL 5 min).

**Nivel 3 — Agente LLM de identificacion** (`src/llm/identificationAgent.ts`):

El agente tiene 4 herramientas disponibles:
- `searchCustomers` — busca clientes por nombre, telefono o email
- `searchTeamMembers` — busca vendedores/asesores del equipo
- `searchByAccountManager` — busca clientes de un vendedor especifico
- `createCustomer` — registra un cliente nuevo (solo si confirma)

Marcadores de salida: `[IDENTIFIED:id:nombre]`, `[CREATED:id:nombre]`, `[TRANSFER]`.

### 4.3 LLM conversacional

El sistema usa Azure OpenAI (gpt-4o-mini) con system prompts contextuales para cada paso. Configurado en `src/dialogue/conversationalLlm.ts`:

- Cada paso tiene un `StepContext` con objetivo, campos a extraer e info extra
- El LLM responde en formato JSON estructurado: `{"reply": "...", "data": {...}}`
- Maximo 120 tokens, temperatura 0.4
- Timeout de 5s para procesamiento LLM, 6s para busquedas API
- Si Azure OpenAI no esta disponible, el sistema usa reglas deterministas como fallback

**Personalidad:** Sara (ES) / Sarah (EN) — recepcionista calida, casual y profesional. Respuestas de 1-2 oraciones. Usa expresiones naturales, fillers, y backchannels. Ver `docs/CONVERSATIONAL_STYLE.md`.

---

## 5. Sistema de voz en tiempo real

### 5.1 WebSocket (`/ws/voice`)

El servidor WebSocket en `src/realtime/voiceWebSocket.ts` maneja la comunicacion bidireccional de audio. Ver documentacion del protocolo en `docs/VOICE_WEBSOCKET_PROTOCOL.md`.

**Resumen del protocolo:**

| Direccion | Tipo | Descripcion |
|-----------|------|-------------|
| C→S | `init` | Inicia sesion con callerId y companyPhone |
| C→S | `language` | Selecciona idioma (es/en) |
| C→S | `text` | Entrada por teclado (bypass STT) |
| C→S | binario | Audio PCM 16-bit 16kHz mono |
| C→S | `hangup` | Termina la llamada |
| C→S | `ping` | Keep-alive |
| S→C | `greeting` | Saludo inicial |
| S→C | `interim` | Transcripcion parcial |
| S→C | `final` | Respuesta de la IA + estado |
| S→C | `audio` | Fragmento TTS (MP3 base64) |
| S→C | `state` | Cambios de estado (listening, speaking) |
| S→C | `finished` | Conversacion terminada |
| S→C | `error` | Error |
| S→C | `pong` | Respuesta a ping |

### 5.2 Concurrencia y limites

| Parametro | Valor | Ubicacion |
|-----------|-------|-----------|
| Sesiones WebSocket simultaneas | 20 max | `MAX_CONCURRENT_SESSIONS` en voiceWebSocket.ts |
| Operaciones TTS simultaneas | 15 max | `MAX_CONCURRENT_TTS` en azureSpeechSdkTts.ts |
| Timeout de TTS | 10s | `TTS_TIMEOUT_MS` en azureSpeechSdkTts.ts |
| Timeout de inactividad | 5 min | `SESSION_TIMEOUT_MS` en voiceWebSocket.ts |
| Timeout de silencio (WS) | 2s | `SILENCE_TIMEOUT_MS` en voiceWebSocket.ts |
| Timeout de silencio (STT) | 1s | `silenceTimeoutMs: 1000` en azureSpeechStt.ts |
| Timeout LLM | 10s | `LLM_TIMEOUT` en azureOpenaiClient.ts |
| Timeout busqueda API | 30s | axios default en appointmentsClient.ts |

**Aislamiento por sesion:**
- Cada sesion WebSocket tiene su propio `VoiceSession` con estado independiente
- Cada operacion TTS crea su propio `SpeechConfig` (evita race conditions entre idiomas)
- Cada recognizer STT tiene su propio `SpeechConfig` con idioma aislado
- Cola FIFO para TTS cuando se alcanza el limite concurrente

### 5.3 Barge-in y control de turnos

- `VoiceSession` tiene `currentTtsId` y `pendingBargeIn`
- Si el usuario envia audio mientras TTS reproduce → `cancelCurrentSpeech()` cancela el TTS
- En `speakResponse` se verifica `ttsId` antes de enviar cada fragmento
- El recognizer STT se reanuda tras la cancelacion

### 5.4 Graceful shutdown

Al recibir `SIGTERM` o `SIGINT`:
1. Notifica a todos los clientes WebSocket conectados
2. Detiene todos los recognizers STT activos
3. Cierra todas las conexiones y libera estados
4. Cierra el servidor HTTP
5. Force-exit despues de 10s si algo se cuelga

### 5.5 Azure Speech SDK

**STT (Speech-to-Text)** — `src/stt/azureSpeechStt.ts`
- Usa `PushAudioInputStream` para recibir audio en streaming
- Reconocimiento continuo con resultados interim y finales
- Timeout de silencio: 1000ms (`Speech_SegmentationSilenceTimeoutMs`)
- Timeout de silencio inicial: 10s (`InitialSilenceTimeoutMs`)

**TTS (Text-to-Speech)** — `src/tts/azureSpeechSdkTts.ts`
- Streaming por frase (divide texto, sintetiza sentencia por sentencia)
- SSML con prosodia, pausas, enfasis, `<say-as>` y estilos emocionales
- Output: MP3 24kHz 48kbps
- Voces por defecto:
  - Espanol: `es-MX-DaliaNeural` (estilo cheerful, grado 0.8)
  - Ingles: `en-US-JennyNeural` (estilo friendly, grado 0.9)
- Fallback a REST API (`azureNeuralTts.ts`) si el SDK falla

### 5.6 Telemetria

Logs automaticos:
- `t_connect_to_greeting` — latencia de conexion a saludo
- `t_language_to_identified_greeting` — latencia de idioma a saludo identificado
- `t_user_final_to_first_audio_chunk` — latencia de voz a respuesta (<500ms ideal)
- `tts_ms`, `tts_bytes` — duracion y tamano de TTS por frase
- Estadisticas periodicas cada 5 min (sesiones activas, TTS active/queued)

---

## 6. API de BlindsBook — Integracion

### 6.1 TokenManager (`src/blindsbook/tokenManager.ts`)

1. **Login** como superusuario con `BLINDSBOOK_LOGIN_EMAIL` / `BLINDSBOOK_LOGIN_PASSWORD`
2. **Switch-company** para cada compania registrada en `PHONE_TO_COMPANY_MAP`
3. **Renovacion proactiva** cada 30 minutos
4. **Retry** automatico: 3 intentos con backoff de 5s
5. **Lock de login** para evitar logins concurrentes
6. **Fallback** a tokens estaticos si el auto-login falla

### 6.2 Busqueda de clientes (`src/blindsbook/appointmentsClient.ts`)

- `findCustomersByPhone(phone)` — `GET /customers/quick-search` con cache 5 min
- `findCustomersBySearch(term)` — busca por nombre (quick-search → fallback `/customers`)
- `findCustomersByAccountManager(search, id)` — filtra clientes por vendedor
- `searchTeamMembers(search)` — busca vendedores/asesores del equipo
- `createNewCustomer(firstName, lastName, phone)` — registra cliente nuevo

### 6.3 Creacion de citas

```typescript
interface CreateAppointmentPayload {
  customerId: number;          // ID del cliente identificado
  type: 0 | 1 | 2;            // 0=Quote, 1=Install, 2=Repair
  startDate: string;           // ISO 8601
  duration?: string;           // "HH:MM:SS" (default: "01:00:00")
  status?: 0 | 1 | 2;         // 0=Pending (default)
  userId?: number;             // accountManagerId del cliente
  saleOrderId?: number;
  installationContactId?: number;
  remarks?: string;
}
```

El `userId` se asigna al `accountManagerId` del cliente para que la cita aparezca en el calendario del asesor correcto.

---

## 7. OCR — Deteccion de marco de ventana

Endpoint `POST /ocr/window-frame` (Drapery Calculator). Cascada: Azure Vision GPT-4o → Sharp edge detection.

---

## 8. Configuracion y despliegue

### 8.1 Variables de entorno

Copiar `.env.example` a `.env` y configurar:

**Requeridas:**

| Variable | Descripcion |
|----------|-------------|
| `AZURE_OPENAI_ENDPOINT` | `https://tu-recurso.openai.azure.com` |
| `AZURE_OPENAI_API_KEY` | API Key de Azure OpenAI |
| `AZURE_OPENAI_DEPLOYMENT` | Nombre del deployment (ej: `gpt-4o-mini`) |
| `AZURE_SPEECH_KEY` | Clave de Azure Speech Services |
| `AZURE_SPEECH_REGION` | Region de Azure Speech (ej: `eastus`) |
| `BLINDSBOOK_API_BASE_URL` | URL de la API BlindsBook |
| `BLINDSBOOK_LOGIN_EMAIL` | Email del superusuario |
| `BLINDSBOOK_LOGIN_PASSWORD` | Password del superusuario |
| `PHONE_TO_COMPANY_MAP` | Mapeo de numeros a companias (JSON) |

**Opcionales:**

| Variable | Default | Descripcion |
|----------|---------|-------------|
| `PORT` | `4000` | Puerto del servidor |
| `AZURE_TTS_VOICE_ES` | `es-MX-DaliaNeural` | Voz neuronal espanol |
| `AZURE_TTS_VOICE_EN` | `en-US-JennyNeural` | Voz neuronal ingles |
| `AZURE_OPENAI_API_VERSION` | `2024-10-21` | Version API |
| `VOICE_SIMULATOR_ENABLED` | `true` | Habilitar `/test` |

### 8.2 Docker

```powershell
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
docker compose up -d --build
Invoke-RestMethod http://localhost:4100/health
```

- Host `127.0.0.1:4100` → Container `:4000`
- `./public:/app/public:ro` — cambios estaticos sin rebuild
- Limite de memoria: 512MB

### 8.3 Desarrollo local

```bash
npm install
npm run dev    # tsx watch src/index.ts — puerto 4000
```

---

## 9. Endpoints HTTP

| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| `GET` | `/health` | Estado del servicio |
| `POST` | `/debug/chat` | Conversacion texto |
| `POST` | `/debug/voice-chat` | Conversacion + audio TTS |
| `GET` | `/debug/play-audio?text=...&lang=es` | Genera MP3 |
| `GET` | `/debug/customer-lookup?phone=...` | Busca cliente |
| `GET` | `/tts/:id.mp3` | Audio TTS cacheado |
| `POST` | `/ocr/window-frame` | Deteccion de marco |
| `WS` | `/ws/voice` | WebSocket voz en tiempo real |
| `GET` | `/test/*` | Simulador (si habilitado) |

---

## 10. Dependencias principales

| Paquete | Uso |
|---------|-----|
| `express` | Servidor HTTP |
| `ws` | WebSocket server |
| `microsoft-cognitiveservices-speech-sdk` | Azure Speech (STT + TTS) |
| `axios` | Cliente HTTP |
| `chrono-node` | Parser de fechas en lenguaje natural |
| `sharp` | Procesamiento de imagenes (OCR) |
| `zod` | Validacion de schemas |
| `dotenv` | Variables de entorno |

---

## 11. Telefonia en produccion: ACS + Voice Live API

El canal de voz en produccion utiliza **Azure Communication Services (ACS)** y **Azure AI Voice Live API**, reemplazando a Twilio que era el proveedor anterior.

### Ventajas sobre Twilio

| Caracteristica | Twilio (antes) | ACS + Voice Live (ahora) |
|---|---|---|
| STT/TTS | Pipeline propio (Azure Speech SDK) | Gestionado por Voice Live |
| VAD | Timeout de silencio fijo (1-2s) | Semantico multilingue (`azure_semantic_vad_multilingual`) |
| Echo cancellation | No | Si, del lado del servidor |
| Voces | Neuronales estandar | HD con temperatura configurable |
| Function calling | Via nuestro dialogo manager | Directo desde Voice Live |
| Escalamiento | STT/TTS por sesion en nuestro server | Gestionado por Azure |

### Estado actual

- El **WebSocket `/ws/voice`** sigue siendo la interfaz principal del agente de voz
- ACS se conecta mediante un **puente** que reenvía audio bidireccional a Voice Live
- La variable de entorno se llama **`PHONE_TO_COMPANY_MAP`**

Para detalles tecnicos, ver:
- `docs/ACS_VOICE_LIVE_INTEGRATION.md` — Arquitectura del puente ACS
- `docs/PLAN_VOICE_AGENT_ACS_VOICE_LIVE.md` — Plan de fases y criterios

---

## 12. Troubleshooting

| Problema | Solucion |
|----------|----------|
| Simulador en "Conectando..." | Verificar Docker: `docker ps`, logs: `docker compose logs --tail 30 blindsbook-ia` |
| TokenManager falla | Verificar `BLINDSBOOK_LOGIN_EMAIL`/`PASSWORD`, acceso a API |
| Voz robotica / sin audio | Verificar `AZURE_SPEECH_KEY`/`REGION`. Probar: `/debug/play-audio?text=Hola&lang=es` |
| `"llm": "none"` | Variables Azure OpenAI vacias. `docker compose exec blindsbook-ia printenv \| grep AZURE_OPENAI` |
| Identificacion lenta | Cache 5 min. Primera busqueda ~3s, Cold start API ~10-15s |
| Puerto 4100 en uso | `netstat -ano \| findstr :4100`. Cambiar en `docker-compose.yml` |
| Cambios en src/ no se ven | Requiere rebuild: `docker compose up --build -d` |

---

*Ultima actualizacion: Marzo 2026*
