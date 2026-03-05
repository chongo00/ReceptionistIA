# BlindsBook — Receptionist IA

Agente de call center automatizado que atiende llamadas telefonicas, identifica clientes y gestiona citas en BlindsBook. Tambien expone un endpoint OCR para deteccion de marcos de ventana.

## Stack tecnologico

- **Runtime:** Node.js 22+ / TypeScript
- **LLM:** Azure OpenAI (gpt-4o-mini) — Ollama como fallback
- **Voz:** Azure Speech SDK (STT + TTS neuronal)
- **Telefonia:** ACS + Voice Live API (produccion) / WebSocket (desarrollo)
- **Backend:** API BlindsBook (NestJS / SQL Server)
- **Container:** Docker multi-stage (~200MB)

## Arquitectura

```
    ACS / WebSocket ──→ Express (4000)
                              │
                   ┌──────────┴──────────┐
                   │  Dialogue Manager   │  OCR Controller
                   │  (maquina estados)  │  (Azure Vision + Sharp)
                   │       │             │
                   │  Azure OpenAI       │
                   │  Azure Speech       │
                   │       │             │
                   │  BlindsBook API     │
                   │  (TokenManager)     │
                   └─────────────────────┘
```

**Concurrencia:** Hasta 20 llamadas simultaneas con aislamiento completo por sesion. Rate limiting de 15 operaciones TTS concurrentes. Graceful shutdown con limpieza de recursos.

## Inicio rapido (Docker)

```bash
cp .env.example .env
# Editar .env con credenciales de Azure OpenAI, Azure Speech, BlindsBook API

docker compose up -d --build
curl http://localhost:4100/health
```

Simulador de llamada: `http://localhost:4100/test/voice-test-v2.html`

## Desarrollo local

```bash
npm install
npm run dev
# Servidor en http://localhost:4000
```

## Variables de entorno principales

| Variable | Descripcion |
|----------|-------------|
| `AZURE_OPENAI_ENDPOINT` | Endpoint Azure OpenAI |
| `AZURE_OPENAI_API_KEY` | API Key Azure OpenAI |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment (ej: `gpt-4o-mini`) |
| `AZURE_SPEECH_KEY` | Clave Azure Speech |
| `AZURE_SPEECH_REGION` | Region (ej: `eastus`) |
| `BLINDSBOOK_API_BASE_URL` | URL de la API BlindsBook |
| `BLINDSBOOK_LOGIN_EMAIL` | Email superusuario |
| `BLINDSBOOK_LOGIN_PASSWORD` | Password superusuario |
| `PHONE_TO_COMPANY_MAP` | Mapeo numeros → companias (JSON) |

Ver `.env.example` para la lista completa.

## Flujo conversacional

```
Llamada entra → Seleccion de idioma (ES/EN)
  → Identificacion (Caller ID → Nombre → LLM fallback)
    → Tipo de cita (cotizacion / instalacion / reparacion)
      → Fecha y hora (lenguaje natural)
        → Confirmacion → Cita creada en BlindsBook
```

## Endpoints

| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| `GET` | `/health` | Estado del servicio y sesiones activas |
| `WS` | `/ws/voice` | WebSocket para voz en tiempo real |
| `POST` | `/debug/chat` | Simula conversacion por texto |
| `POST` | `/debug/voice-chat` | Conversacion + audio TTS |
| `GET` | `/debug/customer-lookup?phone=...` | Busqueda de clientes |
| `POST` | `/ocr/window-frame` | OCR marco de ventana |

## Documentacion

| Documento | Contenido |
|-----------|-----------|
| [`docs/DOCUMENTACION_GENERAL.md`](docs/DOCUMENTACION_GENERAL.md) | Documentacion tecnica completa: arquitectura, flujo, concurrencia, despliegue, troubleshooting |
| [`docs/GUIA_PRUEBAS_MANUALES.md`](docs/GUIA_PRUEBAS_MANUALES.md) | Guia de pruebas: escenarios, numeros de prueba, verificacion |
