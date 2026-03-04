# Receptionist IA — Documentacion General

Documentacion tecnica completa del sistema de recepcionista telefonica inteligente de BlindsBook.

---

## 1. Vision general

Receptionist IA es un servicio Node.js/TypeScript que actua como **agente de call center automatizado** para BlindsBook. El sistema:

- Recibe llamadas telefonicas via Twilio o conexiones WebSocket en tiempo real
- Identifica al cliente automaticamente por Caller ID, nombre o telefono
- Gestiona conversaciones bilingues (espanol/ingles) con voz neuronal
- Crea citas (quotes, instalaciones, reparaciones) directamente en la API de BlindsBook
- Soporta multiples llamadas simultaneas con aislamiento completo por sesion
- Tambien expone un endpoint OCR para deteccion de marcos de ventana (Drapery Calculator)

### Servicios externos utilizados

| Servicio | Funcion | Requerido |
|----------|---------|-----------|
| **Azure OpenAI** (gpt-4o-mini) | LLM principal — comprension conversacional | Si |
| **Azure Speech SDK** | STT (Speech-to-Text) + TTS (Text-to-Speech) neuronal | Si |
| **Twilio** | Telefonia — recibe llamadas reales | Solo produccion |
| **API BlindsBook** | Backend — clientes, citas, usuarios | Si |
| **Ollama** (qwen2.5:3b) | LLM local de fallback si Azure OpenAI no esta disponible | No |

---

## 2. Arquitectura

```
    Llamada telefonica          Navegador (voice-test-v2)         Drapery Calculator App
          |                              |                                |
       Twilio                    WebSocket /ws/voice               POST /ocr/window-frame
          |                              |                                |
    ┌─────┴──────────────── Express (puerto 4000) ────────────────────────┐
    |                                                                      |
    |  ┌─────────────────────────────────────┐    ┌──────────────────────┐ |
    |  |       Voice WebSocket Handler       |    |   OCR Controller     | |
    |  |  - Sesiones concurrentes (max 20)   |    |  - Azure Vision      | |
    |  |  - Azure STT (speech-to-text)       |    |  - Sharp (edges)     | |
    |  |  - Azure TTS (text-to-speech)       |    └──────────────────────┘ |
    |  |  - Rate limiting TTS (max 15)       |                             |
    |  └────────────┬────────────────────────┘                             |
    |               |                                                      |
    |  ┌────────────┴────────────────────────┐                             |
    |  |        Dialogue Manager             |                             |
    |  |  - Maquina de estados por llamada   |                             |
    |  |  - Identificacion (3 niveles)       |                             |
    |  |  - LLM conversacional               |                             |
    |  |  - Parser de fechas (chrono-node)   |                             |
    |  └────────────┬────────────────────────┘                             |
    |               |                                                      |
    |  ┌────────────┴────────────────────────┐                             |
    |  |    BlindsBook API Client            |                             |
    |  |  - TokenManager (multi-tenant)      |                             |
    |  |  - Cache de busquedas               |                             |
    |  |  - Endpoints optimizados            |                             |
    |  └─────────────────────────────────────┘                             |
    └──────────────────────────────────────────────────────────────────────┘
```

### Multi-tenant

El sistema soporta multiples empresas en un mismo servidor. Cada numero Twilio se mapea a una compania en la API de BlindsBook:

```
TWILIO_NUMBER_TO_COMPANY_MAP={"+15550001":{"companyId":2},"+15550002":{"companyId":163}}
```

El `TokenManager` se autentica automaticamente como superusuario y usa `POST /auth/switch-company` para obtener tokens JWT por empresa, renovandolos proactivamente cada 30 minutos.

---

## 3. Estructura del proyecto

```
Receptionist IA/
├── src/
│   ├── index.ts                         # Punto de entrada
│   ├── server.ts                        # Express + HTTP server + graceful shutdown
│   ├── config/
│   │   └── env.ts                       # Variables de entorno (EnvConfig)
│   ├── realtime/
│   │   └── voiceWebSocket.ts            # WebSocket server para voz en tiempo real
│   ├── dialogue/
│   │   ├── state.ts                     # ConversationState, ConversationStep, CustomerMatch
│   │   ├── manager.ts                   # Maquina de estados principal (handleUserInput)
│   │   ├── conversationalLlm.ts         # Prompts del LLM conversacional
│   │   ├── dateParser.ts                # Parser de fechas naturales (chrono-node)
│   │   └── humanizer.ts                 # Enriquecimiento SSML para voz natural
│   ├── stt/
│   │   └── azureSpeechStt.ts            # Speech-to-Text (Azure Speech SDK)
│   ├── tts/
│   │   ├── azureSpeechSdkTts.ts         # TTS principal (Azure Speech SDK, concurrency-safe)
│   │   ├── azureNeuralTts.ts            # TTS via REST API (fallback)
│   │   ├── ttsProvider.ts               # Selector de TTS: SDK > REST > Docker > none
│   │   ├── ttsCache.ts                  # Cache temporal de MP3 (TTL configurable)
│   │   └── dockerTts.ts                 # Cliente Piper TTS (Docker local, opcional)
│   ├── llm/
│   │   ├── llmClient.ts                 # Selector LLM: Azure OpenAI > Ollama
│   │   ├── azureOpenaiClient.ts         # Cliente Azure OpenAI
│   │   ├── ollamaClient.ts             # Cliente Ollama (fallback)
│   │   └── identificationAgent.ts       # Agente LLM nivel 3 (tool calling)
│   ├── blindsbook/
│   │   ├── appointmentsClient.ts        # Cliente API: clientes, citas, busquedas
│   │   └── tokenManager.ts             # Gestion de tokens JWT multi-tenant
│   ├── twilio/
│   │   └── voiceWebhook.ts             # Webhook Twilio (TwiML)
│   ├── ocr/
│   │   ├── windowFrameDetector.ts       # Deteccion de marcos (Sharp + Laplaciano)
│   │   └── azureVisionOcr.ts           # OCR con Azure OpenAI Vision (GPT-4o)
│   └── models/
│       └── appointments.ts              # Tipos: AppointmentType, CreateAppointmentPayload
├── public/
│   ├── voice-test-v2.html               # Simulador de llamada WebSocket
│   └── mic-test.html                    # Diagnostico de microfono
├── scripts/
│   ├── test_chat.ps1                    # Script PowerShell para pruebas de chat
│   └── check-appointments.cjs           # Verificacion de citas creadas
├── docs/
│   ├── DOCUMENTACION_GENERAL.md         # Este documento
│   └── GUIA_PRUEBAS_MANUALES.md        # Guia de pruebas con escenarios detallados
├── Dockerfile                           # Imagen basica Node.js
├── Dockerfile.cloud                     # Imagen multi-stage para produccion (~200MB)
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
           │                           │         llmFallback (Azure OpenAI)
           │                           │
    greeting ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
        │
    askType → (cotizacion / instalacion / reparacion)
        │
    askDate → (fecha en lenguaje natural: "manana", "el lunes", "3 de marzo")
        │
    askTime → (hora: "a las 3", "3pm", "por la manana")
        │
    confirmSummary → (resumen completo de la cita)
        │
    creatingAppointment → POST /appointments en API BlindsBook
        │
    completed → (despedida)
```

### 4.2 Identificacion de cliente (3 niveles)

| Nivel | Mecanismo | Tiempo tipico | Uso |
|-------|-----------|---------------|-----|
| 1 | **Caller ID** — busca por telefono automaticamente | ~3s | ~60% de las llamadas |
| 2 | **Nombre/telefono** — el cliente lo dice verbalmente | ~2s | ~30% de las llamadas |
| 3 | **LLM (Azure OpenAI)** — tool calling contra la API | ~5s | ~10% casos complejos |

La busqueda de clientes usa el endpoint optimizado `GET /customers/quick-search` de la API BlindsBook, con normalizacion de telefono (elimina codigo de pais +1) y cache en memoria.

### 4.3 LLM conversacional

El sistema usa Azure OpenAI (gpt-4o-mini) para:
- Comprender respuestas ambiguas del usuario
- Generar respuestas naturales y proactivas
- Nivel 3 de identificacion (tool calling: busca clientes por nombre/telefono)

El LLM recibe un system prompt contextual segun el paso actual de la conversacion, configurado en `src/dialogue/conversationalLlm.ts`.

---

## 5. Sistema de voz en tiempo real

### 5.1 WebSocket (`/ws/voice`)

El servidor WebSocket en `src/realtime/voiceWebSocket.ts` maneja la comunicacion bidireccional de audio:

**Protocolo de mensajes (cliente → servidor):**

| Tipo | Payload | Descripcion |
|------|---------|-------------|
| `init` | `{ callerId, companyPhone }` | Inicia sesion con datos del llamante |
| `language` | `{ language: "es" \| "en" }` | Selecciona idioma |
| `text` | `{ text: "..." }` | Envia texto (bypass de STT) |
| `audio` | `Buffer (binario)` | Audio PCM 16-bit 16kHz |
| `hangup` | – | Termina la llamada |
| `ping` | – | Keep-alive |

**Protocolo de mensajes (servidor → cliente):**

| Tipo | Payload | Descripcion |
|------|---------|-------------|
| `greeting` | `{ text, state }` | Saludo inicial |
| `interim` | `{ text }` | Transcripcion parcial (mientras habla) |
| `final` | `{ text, state }` | Respuesta de la IA |
| `audio` | `{ audioBase64, text }` | Audio MP3 de la respuesta |
| `state` | `{ data }` | Cambios de estado (listening, speaking) |
| `finished` | `{ text }` | Conversacion terminada |
| `error` | `{ text }` | Error |

### 5.2 Concurrencia y limites

| Parametro | Valor | Configurable |
|-----------|-------|-------------|
| Sesiones WebSocket simultaneas | 20 max | `MAX_CONCURRENT_SESSIONS` en voiceWebSocket.ts |
| Operaciones TTS simultaneas | 15 max | `MAX_CONCURRENT_TTS` en azureSpeechSdkTts.ts |
| Timeout de TTS | 10s | `TTS_TIMEOUT_MS` en azureSpeechSdkTts.ts |
| Timeout de inactividad | 5 min | `SESSION_TIMEOUT_MS` en voiceWebSocket.ts |
| Timeout de silencio (STT) | 2s | `SILENCE_TIMEOUT_MS` en voiceWebSocket.ts |

**Aislamiento por sesion:**
- Cada sesion WebSocket tiene su propio `VoiceSession` con estado independiente
- Cada operacion TTS crea su propio `SpeechConfig` (evita race conditions entre idiomas)
- Cada recognizer STT tiene su propio `SpeechConfig` con idioma aislado
- Cola FIFO para TTS cuando se alcanza el limite concurrente (las siguientes esperan turno)

### 5.3 Graceful shutdown

Al recibir `SIGTERM` o `SIGINT`:
1. Notifica a todos los clientes WebSocket conectados
2. Detiene todos los recognizers STT activos
3. Cierra todas las conexiones
4. Libera estados de conversacion
5. Cierra el servidor HTTP
6. Force-exit despues de 10s si algo se cuelga

### 5.4 Azure Speech SDK

**STT (Speech-to-Text)** — `src/stt/azureSpeechStt.ts`
- Usa `PushAudioInputStream` para recibir audio en streaming
- Reconocimiento continuo con resultados interim y finales
- Deteccion de silencio configurable (1.5s por defecto)

**TTS (Text-to-Speech)** — `src/tts/azureSpeechSdkTts.ts`
- Voces neuronales con estilos emocionales (cheerful, friendly)
- SSML avanzado: pausas, prosodia, enfasis, `<say-as>` para numeros/fechas
- Output: MP3 24kHz 48kbps
- Voces por defecto:
  - Espanol: `es-MX-JorgeNeural` (o `es-ES-ElviraNeural` via env)
  - Ingles: `en-US-JennyNeural`

---

## 6. API de BlindsBook — Integracion

### 6.1 TokenManager (`src/blindsbook/tokenManager.ts`)

Gestiona la autenticacion multi-tenant:

1. **Login** como superusuario con `BLINDSBOOK_LOGIN_EMAIL` / `BLINDSBOOK_LOGIN_PASSWORD`
2. **Switch-company** para cada compania registrada en `TWILIO_NUMBER_TO_COMPANY_MAP`
3. **Renovacion proactiva** cada 30 minutos (los tokens duran 1440 min / 24h)
4. **Retry** automatico: 3 intentos con backoff exponencial

### 6.2 Busqueda de clientes (`src/blindsbook/appointmentsClient.ts`)

- `findCustomersByPhone(phone)` — Busca por telefono usando `GET /customers/quick-search`
  - Normaliza telefono: elimina prefijo +1 para numeros US
  - Cache en memoria con TTL de 5 minutos
  - Fallback a endpoint legacy si quick-search falla
- `findCustomersBySearch(term)` — Busca por nombre o termino libre
- Timeout de 30s en todas las llamadas HTTP (axios)

### 6.3 Creacion de citas

Payload enviado a `POST /appointments`:

```typescript
interface CreateAppointmentPayload {
  customerId: number;          // ID del cliente identificado
  type: 0 | 1 | 2;            // 0=Quote, 1=Install, 2=Repair
  startDate: string;           // ISO 8601
  duration?: string;           // "HH:MM:SS" (default: "01:00:00")
  status?: 0 | 1 | 2;         // 0=Pending (default)
  userId?: number;             // Usuario asignado (accountManagerId del cliente)
  saleOrderId?: number;        // Requerido si type=1 (instalacion)
  installationContactId?: number;
  remarks?: string;
}
```

---

## 7. OCR — Deteccion de marco de ventana

Endpoint `POST /ocr/window-frame` usado por la app Drapery Calculator.

**Cascada de deteccion:**

| Nivel | Motor | Precision |
|-------|-------|-----------|
| 1 | Azure OpenAI Vision (GPT-4o) | Alta (~95%) |
| 2 | Sharp + Laplaciano (edge detection) | Media (~70%) |

**Request:**
```json
{
  "image": "data:image/jpeg;base64,/9j/...",
  "width": 1920,
  "height": 1080
}
```

**Response:**
```json
{
  "rectangle": {
    "topLeft": { "x": 120, "y": 80 },
    "topRight": { "x": 1800, "y": 80 },
    "bottomLeft": { "x": 120, "y": 1000 },
    "bottomRight": { "x": 1800, "y": 1000 },
    "width": 1680,
    "height": 920
  },
  "confidence": 0.82
}
```

---

## 8. Configuracion y despliegue

### 8.1 Variables de entorno

Copiar `.env.example` a `.env` y configurar:

**Requeridas:**

| Variable | Descripcion |
|----------|-------------|
| `AZURE_OPENAI_ENDPOINT` | Endpoint de Azure OpenAI (ej: `https://tu-recurso.openai.azure.com`) |
| `AZURE_OPENAI_API_KEY` | API Key de Azure OpenAI |
| `AZURE_OPENAI_DEPLOYMENT` | Nombre del deployment (ej: `gpt-4o-mini`) |
| `AZURE_SPEECH_KEY` | Clave de Azure Speech Services |
| `AZURE_SPEECH_REGION` | Region de Azure Speech (ej: `eastus`) |
| `BLINDSBOOK_API_BASE_URL` | URL de la API BlindsBook |
| `BLINDSBOOK_LOGIN_EMAIL` | Email del superusuario para auto-login |
| `BLINDSBOOK_LOGIN_PASSWORD` | Password del superusuario |
| `TWILIO_NUMBER_TO_COMPANY_MAP` | Mapeo de numeros Twilio a companias (JSON) |

**Opcionales:**

| Variable | Descripcion | Default |
|----------|-------------|---------|
| `PORT` | Puerto del servidor | `4000` |
| `PUBLIC_BASE_URL` | URL publica (para Twilio `<Play>`) | – |
| `AZURE_TTS_VOICE_ES` | Voz neuronal espanol | `es-MX-JorgeNeural` |
| `AZURE_TTS_VOICE_EN` | Voz neuronal ingles | `en-US-JennyNeural` |
| `AZURE_OPENAI_API_VERSION` | Version de la API | `2024-10-21` |
| `TWILIO_AUTH_TOKEN` | Token para validar firmas Twilio | – |
| `TWILIO_VALIDATE_SIGNATURE` | Validar firma de Twilio | `true` |
| `OLLAMA_URL` | URL de Ollama (fallback LLM) | – |
| `OLLAMA_MODEL` | Modelo Ollama | `qwen2.5:3b` |
| `DOCKER_TTS_URL` | URL de Piper TTS local | – |

### 8.2 Docker (recomendado)

```bash
# Clonar y configurar
cd "Receptionist IA"
cp .env.example .env
# Editar .env con tus credenciales

# Construir y levantar
docker compose up -d --build

# Verificar
curl http://localhost:4100/health
```

El `docker-compose.yml` mapea:
- Host `127.0.0.1:4100` → Container `:4000`
- Monta `./public:/app/public:ro` para cambios en archivos estaticos sin rebuild

El `Dockerfile.cloud` usa multi-stage build:
1. **Builder**: compila TypeScript a JavaScript
2. **Runtime**: solo Node.js + dependencias de produccion (~200MB)

### 8.3 Desarrollo local (sin Docker)

```bash
npm install
npm run dev    # ts-node con watch
```

El servidor escucha en `http://localhost:4000`.

### 8.4 Recursos Azure necesarios

| Recurso | SKU recomendado | Proposito |
|---------|----------------|-----------|
| Azure OpenAI | S0 | LLM (gpt-4o-mini) |
| Azure Speech | S0 | STT + TTS neuronal |
| Azure OpenAI (Vision) | Mismo recurso | OCR con GPT-4o (opcional) |

**Crear recurso Azure OpenAI:**
1. Portal Azure → "Azure OpenAI" → Create
2. Deploy modelo `gpt-4o-mini`
3. Copiar Endpoint + API Key al `.env`

**Crear recurso Azure Speech:**
1. Portal Azure → "Speech services" → Create
2. Copiar Key + Region al `.env`

---

## 9. Endpoints HTTP

| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| `GET` | `/health` | Estado del servicio (LLM, TTS, STT, sesiones activas) |
| `POST` | `/debug/chat` | Simula turno de conversacion (texto) |
| `POST` | `/debug/voice-chat` | Turno de conversacion + audio TTS |
| `GET` | `/debug/play-audio?text=...&lang=es` | Genera MP3 de un texto |
| `GET` | `/debug/customer-lookup?phone=...` | Busca cliente por telefono en todas las companias |
| `GET` | `/tts/:id.mp3` | Sirve audio TTS cacheado |
| `POST` | `/twilio/voice-webhook` | Webhook Twilio (TwiML) |
| `POST` | `/ocr/window-frame` | Deteccion de marco de ventana |
| `WS` | `/ws/voice` | WebSocket para voz en tiempo real |
| `GET` | `/test/voice-test-v2.html` | UI de simulador de llamada |
| `GET` | `/test/mic-test.html` | Diagnostico de microfono |

---

## 10. Pruebas

### 10.1 Simulador de llamada (navegador)

Abrir `http://localhost:4100/test/voice-test-v2.html`:
1. Ingresar numero de telefono del cliente
2. Click en "Llamar"
3. Seleccionar idioma
4. Conversar por voz o texto

### 10.2 Chat por texto (cURL / PowerShell)

```bash
# Inicio de conversacion
curl -X POST http://localhost:4100/debug/chat \
  -H "Content-Type: application/json" \
  -d '{"callId":"test-1","text":null,"fromNumber":"+13055452936","toNumber":"+15550000001"}'

# Seleccionar espanol
curl -X POST http://localhost:4100/debug/chat \
  -H "Content-Type: application/json" \
  -d '{"callId":"test-1","text":"1"}'

# Solicitar cita
curl -X POST http://localhost:4100/debug/chat \
  -H "Content-Type: application/json" \
  -d '{"callId":"test-1","text":"quiero agendar una cita de reparacion para manana a las 3 de la tarde"}'
```

### 10.3 Busqueda de clientes

```bash
curl "http://localhost:4100/debug/customer-lookup?phone=3055452936"
```

### 10.4 Health check

```bash
curl http://localhost:4100/health
```

Respuesta esperada:
```json
{
  "ok": true,
  "service": "blindsbook-ia",
  "status": "healthy",
  "llm": "azure-openai",
  "tts": "azure-speech-sdk",
  "stt": "azure-speech-sdk",
  "voiceWebSocket": "ready",
  "sessions": {
    "active": 0,
    "max": 20,
    "tts": { "active": 0, "queued": 0, "max": 15 }
  }
}
```

Para escenarios de prueba detallados, ver [`GUIA_PRUEBAS_MANUALES.md`](GUIA_PRUEBAS_MANUALES.md).

---

## 11. Dependencias principales

| Paquete | Uso |
|---------|-----|
| `express` | Servidor HTTP |
| `ws` | WebSocket server |
| `microsoft-cognitiveservices-speech-sdk` | Azure Speech (STT + TTS) |
| `axios` | Cliente HTTP para API BlindsBook |
| `chrono-node` | Parser de fechas en lenguaje natural |
| `twilio` | SDK de Twilio para validacion de webhooks |
| `sharp` | Procesamiento de imagenes (OCR) |
| `zod` | Validacion de schemas |
| `dotenv` | Variables de entorno |
| `body-parser` / `cors` | Middleware Express |

---

## 12. Troubleshooting

### El simulador se queda en "Conectando con IA..."
- Verificar que Docker esta corriendo: `docker ps`
- Verificar logs: `docker logs receptionistia-blindsbook-ia-1 --tail 30`
- Verificar que el puerto 4100 esta accesible: `curl http://localhost:4100/health`

### TokenManager falla al autenticarse
- Verificar credenciales en `.env`: `BLINDSBOOK_LOGIN_EMAIL` y `BLINDSBOOK_LOGIN_PASSWORD`
- Verificar que la API BlindsBook es accesible desde Docker: `BLINDSBOOK_API_BASE_URL`
- Si una compania especifica falla (401), verificar que el superusuario tiene permisos para esa compania

### La voz suena robotica
- Verificar que `AZURE_SPEECH_KEY` y `AZURE_SPEECH_REGION` estan configurados
- Verificar voces en `.env`: `AZURE_TTS_VOICE_ES=es-MX-JorgeNeural`
- El sistema usa SSML con prosodia y estilos emocionales para naturalidad

### Identificacion de cliente muy lenta (>10s)
- La busqueda usa `quick-search` endpoint optimizado de la API BlindsBook
- Verificar cache: primera busqueda ~3s, siguientes <1ms (cache 5 min)
- Timeout maximo: 18s (configurable en `manager.ts`)

### Puerto 4100 en uso
- Docker mapea 4100 (host) → 4000 (container)
- Verificar procesos: `netstat -ano | findstr :4100`
- Cambiar puerto en `docker-compose.yml` si hay conflicto

### Docker no refleja cambios en el codigo
- Los archivos en `src/` requieren rebuild: `docker compose up --build -d`
- Los archivos en `public/` se reflejan inmediatamente (volume mount)
