# Guía de pruebas en local (RecepcionistIA + BlindsBook)

Esta guía te deja un **entorno de pruebas local** para que puedas llamar por teléfono (Twilio) y que la recepcionista IA cree citas usando la **API existente de BlindsBook**.

## 0) Qué hace exactamente este servicio

- **RecepcionistIA** (este repo) recibe llamadas vía **Twilio** en `POST /twilio/voice-webhook`.
- Responde con **TwiML** (voz) y va preguntando datos.
- Cuando tiene lo mínimo, intenta llamar a la API de BlindsBook:
  - `POST {BLINDSBOOK_API_BASE_URL}/appointments`

En producción **no toca la BD directamente**: siempre va por la API.

## 1) Requisitos

- Node.js **>= 24.13.0**
- Tener el proyecto BlindsBook API funcionando localmente (puerto 3000).
- **Opción A (100% gratis, sin llamadas reales):** usar el endpoint local `POST /debug/chat`.
- **Opción B (llamadas reales):** cuenta de **Twilio** con número de voz (puede ser trial) + un túnel tipo **ngrok** (o alternativa) para exponer tu webhook local a internet.

## 2) Levantar la API de BlindsBook en local

En tu repo de BlindsBook (ej. `D:\\Disco E trabajos\\repositorio_blindsbook\\App-BlindsBook`):

1. Arranca la API (NestJS):

```bash
cd "D:\Disco E trabajos\repositorio_blindsbook\App-BlindsBook\api"
npm run dev
```

2. Verifica que responde:
   - Swagger (si está habilitado): `http://localhost:3000/api-docs`
   - O cualquier endpoint que ya uses.

## 3) Preparar el servicio RecepcionistIA (local)

En este repo:

```bash
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
npm install
```

### 3.1) Crear `.env`

Ya te dejé un archivo `.env` creado con placeholders. Solo debes completar lo que falta.

- **BLINDSBOOK_API_BASE_URL**: para local debe ser:
  - `http://localhost:3000`

- **BLINDSBOOK_API_TOKEN**:
  - Debe ser un token/JWT válido que tu API acepte para crear citas.
  - Cómo conseguirlo (rápido):
    - Inicia sesión en tu app (web/móvil) contra la API local.
    - Abre DevTools (F12) → Network → busca el response del login.
    - Copia el token y pégalo en `BLINDSBOOK_API_TOKEN`.

- **TWILIO_AUTH_TOKEN**:
  - Tu Auth Token de Twilio (para validación de firma si la activas).

Ejemplo:

```text
PORT=4000
BLINDSBOOK_API_BASE_URL=http://localhost:3000
BLINDSBOOK_API_TOKEN=pega_aqui_tu_jwt
TWILIO_AUTH_TOKEN=tu_twilio_auth_token
TWILIO_VALIDATE_SIGNATURE=true
```

✅ Ya quedó implementado: el servicio ahora intenta resolver `customerId` llamando a:
`GET /customers?search=<texto>` y toma el primer resultado.

### 3.2) Arrancar RecepcionistIA

```bash
npm run dev
```

Verifica:
- `http://localhost:4000/health` devuelve `ok: true`

## 4) Exponer tu webhook local (ngrok)

### ¿Debo instalar algo?

Sí. Para pruebas con llamadas reales, necesitas **instalar y ejecutar** un túnel (ngrok o similar) en tu PC.

En otra terminal:

```bash
ngrok http 4000
```

Ngrok te dará una URL pública, por ejemplo:
- `https://abcd-1234.ngrok-free.app`

Tu webhook quedará:
- `https://abcd-1234.ngrok-free.app/twilio/voice-webhook`

## 5) Configurar Twilio (modo pruebas)

En Twilio Console:

### ¿Debo instalar algo?

- No instalas nada para Twilio: es una cuenta web.
- Necesitas crear una cuenta en Twilio y comprar/usar un número de voz (en trial te dan crédito para pruebas).

1. Ve a tu **Phone Number** (voz).
2. En **Voice configuration**:
   - **A Call Comes In**:
     - Webhook (HTTP POST)
     - URL: `https://<tu-ngrok>/twilio/voice-webhook`
3. Guarda.

### Probar

Llama al número de Twilio. Deberías escuchar las preguntas.

## 6) Español e inglés (estado actual y cómo habilitarlo)

### Estado actual

✅ Ya quedó implementado:
- Primer paso: menú de idioma:
  - “Para español, presione 1. For English, press 2.”
- Las respuestas cambian según el idioma elegido.
- Twilio cambia `language` y voz según idioma.

### Para habilitar bilingüe (recomendación de pruebas)

- Primer paso de llamada: menú DTMF
  - “Para español, presione 1. For English, press 2.”
- Guardar idioma en `ConversationState.language`
- Responder con frases en español o inglés según el idioma
- Cambiar `gather.language` y `say.voice` acorde:
  - Inglés US: `en-US` y una voz en inglés (Polly/Google/Twilio).

## 7) Costos (Twilio y “IA de voz”)

### Twilio Voice

- Twilio cobra normalmente **por minuto de llamada** (según país y tipo de llamada).
- Puedes empezar en **modo trial** (crédito limitado) para probar, pero **Twilio no es 100% gratuito** para llamadas reales.
- Ver precios actuales en “Programmable Voice Pricing” de Twilio:
  - `https://www.twilio.com/voice/pricing`

### Speech-to-Text / Text-to-Speech

En esta versión el flujo usa **TwiML Gather + Say**.
- Dependiendo de tu configuración y proveedor de voz/ASR, puede haber costo adicional.
- Para empezar pruebas, usa trial y mide minutos consumidos.

### Motor “IA” (modelo)

El repo deja variables `AI_SERVICE_URL` y `AI_SERVICE_API_KEY` para conectar un proveedor externo.
- El costo depende del proveedor (Azure/OpenAI/otro).
- Puedes montar un entorno de pruebas y pasar a pago cuando funcione:
  - Trial/Free tier (si aplica) → luego producción.

## 8) Producción (Azure) — checklist rápido

- Desplegar RecepcionistIA en Azure (App Service / Container Apps / VM).
- Configurar HTTPS y un dominio (o URL pública estable).
- Poner `.env` (o App Settings) con:
  - `BLINDSBOOK_API_BASE_URL` de producción
  - `BLINDSBOOK_API_TOKEN` de servicio
  - `TWILIO_AUTH_TOKEN`
- En Twilio cambiar el webhook del número a:
  - `https://tu-dominio/twilio/voice-webhook`
- Activar validación de firma Twilio (recomendado):
  - `TWILIO_VALIDATE_SIGNATURE=true`

## 9) Modo pruebas 100% gratis (sin Twilio)

Si quieres probar ya el flujo sin pagar nada, usa el endpoint local:

- `POST http://localhost:4000/debug/chat`

Ejemplo de body:

```json
{ "callId": "test1", "text": "1" }
```

Luego envías más turnos con el mismo `callId`:

```json
{ "callId": "test1", "text": "cotización" }
```

Esto te permite validar el flujo y que la integración con la API funcione, sin llamadas reales.

