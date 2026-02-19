# BlindsBook IA – Recepcionista Telefónica con IA

Servicio Node.js (TypeScript) que actúa como **recepcionista telefónica inteligente** para gestionar citas de BlindsBook. Atiende llamadas entrantes desde Twilio, identifica al cliente automáticamente, guía la conversación por voz y crea el `appointment` en la API de BlindsBook.

## Arquitectura

```
Llamada entrante
      │
   Twilio (STT)
      │
  Express API (puerto 4000)
      │
  Dialogue Manager
      ├── Nivel 1: Caller ID →  API BlindsBook (búsqueda directa)
      ├── Nivel 2: Nombre/teléfono → API BlindsBook (búsqueda + confirmación)
      └── Nivel 3: LLM fallback → Ollama + Qwen2.5-3B (local, gratis)
      │
  TTS (Azure Neural / Piper local / sin voz)
      │
   Twilio (responde con <Say> o <Play>)
```

El sistema utiliza una **cascada de identificación de 3 niveles** que reconoce al cliente en ~90 % de los casos sin intervención del LLM, reservando Ollama para los casos ambiguos o complejos.

## Estructura del proyecto

```
├── docs/
│   ├── GUIA_PRUEBAS_MANUALES.md            # Guía de pruebas v3.0 — Docker, 14 escenarios
│   ├── PLAN_IDENTIFICACION_CLIENTE_OPCION_D.md  # Plan técnico: cascada 3 niveles + Ollama
│   ├── GUIA_COMPLETA.md                    # Azure Speech, Twilio, ngrok, costos
│   └── Ia.md                               # Alternativas N8N + Gemini/Ollama
├── scripts/
│   └── test_chat.ps1                       # Script PowerShell para pruebas rápidas
├── tests/
│   └── audio/                              # MP3 de prueba generados (ignorados por git)
├── public/
│   └── voice-test.html                     # UI de prueba en navegador (/test/voice-test.html)
├── src/
│   ├── index.ts                            # Punto de entrada
│   ├── server.ts                           # Express: rutas, /health, /debug/*, /twilio
│   ├── config/env.ts                       # Variables de entorno y validación
│   ├── twilio/voiceWebhook.ts              # Webhook Twilio (TwiML)
│   ├── dialogue/
│   │   ├── state.ts                        # ConversationState + ConversationStep
│   │   ├── manager.ts                      # Máquina de estados principal
│   │   └── dateParser.ts                   # Parser de fechas en lenguaje natural
│   ├── blindsbook/
│   │   └── appointmentsClient.ts           # Cliente API BlindsBook (customers, appointments)
│   ├── llm/
│   │   ├── ollamaClient.ts                 # Cliente Ollama (tool calling)
│   │   └── identificationAgent.ts          # Agente LLM para identificación nivel 3
│   ├── tts/
│   │   ├── ttsProvider.ts                  # Selector TTS: Piper → Azure → none
│   │   ├── ttsCache.ts                     # Caché temporal de MP3 (10 min)
│   │   └── dockerTts.ts                    # Cliente Piper TTS (Docker local)
│   └── models/
│       └── appointments.ts                 # Tipos y DTOs
├── Dockerfile                              # Imagen Node.js (blindsbook-ia)
├── Dockerfile.ollama-preloaded             # Imagen Ollama con qwen2.5:3b pre-cargado
├── docker-compose.yml                      # Orquestación: blindsbook-ia + ollama
├── package.json
├── tsconfig.json
└── .env.example
```

## Inicio rápido (Docker — recomendado)

### 1. Clonar y configurar entorno

```bash
cd "Receptionist IA"
cp .env.example .env
# Edita .env con tus credenciales
```

### 2. Construir y levantar los servicios

```bash
docker compose up -d --build
```

Esto construye **dos imágenes**:
- `blindsbook-ia` — el servidor Node.js (puerto 4000)
- `ollama` — Ollama con `qwen2.5:3b` ya descargado dentro de la imagen (no requiere `docker exec` manual)

### 3. Verificar que todo funciona

```bash
# Health check general + estado de Ollama
curl http://localhost:4000/health

# Respuesta esperada:
# {"ok":true,"service":"blindsbook-ia","status":"healthy","ollama":"connected"}
```

### 4. Prueba de conversación (sin Twilio)

```bash
curl -s -X POST http://localhost:4000/debug/chat \
  -H "Content-Type: application/json" \
  -d '{"callId":"test-1","text":null,"fromNumber":"+15550001111","toNumber":"+15559998888"}'
```

Ver la guía completa de pruebas: [`docs/GUIA_PRUEBAS_MANUALES.md`](docs/GUIA_PRUEBAS_MANUALES.md)

---

## Desarrollo local (sin Docker)

```bash
npm install
npm run dev
```

El servidor escucha en `http://localhost:4000`. Para funcionalidad completa necesitas:
- **Ollama** corriendo localmente: `OLLAMA_URL=http://localhost:11434`
- **API de BlindsBook** accesible: `BLINDSBOOK_API_BASE_URL=http://localhost:3000`

---

## Variables de entorno clave

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `4000` |
| `BLINDSBOOK_API_BASE_URL` | URL base de la API BlindsBook | `http://localhost:3000` |
| `BLINDSBOOK_API_TOKEN` | JWT de servicio (opcional si usas login) | – |
| `BLINDSBOOK_LOGIN_EMAIL` | Email para auto-login en dev | – |
| `BLINDSBOOK_LOGIN_PASSWORD` | Password para auto-login en dev | – |
| `TWILIO_AUTH_TOKEN` | Token para validar firmas de Twilio | – |
| `TWILIO_NUMBER_TO_COMPANY_MAP` | JSON: número → companyId + token JWT | `{}` |
| `OLLAMA_URL` | URL del servidor Ollama | `http://localhost:11434` |
| `OLLAMA_MODEL` | Modelo LLM a usar | `qwen2.5:3b` |
| `AZURE_SPEECH_KEY` | Clave Azure Speech (TTS neuronal) | – |
| `AZURE_SPEECH_REGION` | Región Azure Speech | – |
| `DOCKER_TTS_URL` | URL del servicio Piper TTS | `http://localhost:8000` |
| `PUBLIC_BASE_URL` | URL pública del servicio (para Twilio `<Play>`) | – |

### Multi-tenant

El sistema soporta múltiples empresas en el mismo servidor. Cada número Twilio se mapea a una empresa:

```bash
TWILIO_NUMBER_TO_COMPANY_MAP='{"+15550000001":{"token":"jwt_empresa_a","companyId":387},"+15550000002":{"token":"jwt_empresa_b","companyId":412}}'
```

---

## Flujo conversacional

```
Llamada entra
  └─ Identificación nivel 1: Caller ID
       ├─ Encontrado → confirma y continúa
       └─ No encontrado → Nivel 2: pregunta nombre/teléfono
            ├─ Un resultado → confirma y continúa
            ├─ Varios → desambigua (lista opciones)
            └─ Sin resultado → Nivel 3: Ollama LLM
                 └─ Usa tool calling para buscar en la API
  └─ Tipo de cita (cotización / instalación / reparación / otro)
  └─ Fecha y hora
  └─ Crear cita en API BlindsBook
  └─ Confirmación y despedida
```

---

## Endpoints principales

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado del servicio y conexión Ollama |
| `POST` | `/twilio/voice-webhook` | Webhook para llamadas entrantes de Twilio |
| `POST` | `/debug/chat` | Simula turnos de conversación (texto) |
| `POST` | `/debug/voice-chat` | Simula turnos + devuelve audio TTS |
| `GET` | `/debug/play-audio?text=...` | Genera y reproduce MP3 directamente |
| `GET` | `/tts/:id.mp3` | Sirve audio TTS (caché 10 min) |
| `GET` | `/test/` | UI de prueba en navegador |

---

## Configuración Twilio

1. Crea o usa un número de teléfono de voz en Twilio.
2. En *A Call Comes In*, configura:
   - Tipo: `Webhook` / `HTTP POST`
   - URL: `https://TU_DOMINIO_PUBLICO/twilio/voice-webhook`
3. En desarrollo puedes usar ngrok: `ngrok http 4000`

---

## Documentación

| Documento | Contenido |
|---|---|
| [docs/GUIA_PRUEBAS_MANUALES.md](docs/GUIA_PRUEBAS_MANUALES.md) | Guía de pruebas v3.0: Docker, 14 escenarios, identificación 3 niveles, troubleshooting |
| [docs/PLAN_IDENTIFICACION_CLIENTE_OPCION_D.md](docs/PLAN_IDENTIFICACION_CLIENTE_OPCION_D.md) | Plan técnico completo: cascada de identificación, Ollama, tool calling, deploy |
| [docs/GUIA_COMPLETA.md](docs/GUIA_COMPLETA.md) | Voz neuronal (Azure Speech), Twilio, ngrok, costos, despliegue en Azure |
| [docs/Ia.md](docs/Ia.md) | Alternativas con N8N + Ollama/Gemini (100 % gratis) |
