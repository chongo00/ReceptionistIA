# Servicio IA Recepcionista de Citas (BlindsBook)

Servicio Node.js (TypeScript) que actúa como **recepcionista telefónica con IA** para gestionar citas de BlindsBook. Atiende llamadas entrantes desde Twilio, guía al cliente mediante voz, recopila datos de la cita y crea el `appointment` en la API existente de BlindsBook.

## Estructura del proyecto

- `package.json` – scripts (`dev`, `build`, `start`) y dependencias.
- `tsconfig.json` – configuración de TypeScript.
- `.env.example` – variables de entorno necesarias.
- `src/index.ts` – punto de entrada.
- `src/server.ts` – servidor HTTP Express y registro de rutas.
- `src/config/env.ts` – carga de configuración desde variables de entorno.
- `src/twilio/voiceWebhook.ts` – webhook principal que Twilio llama en cada interacción de la llamada.
- `src/dialogue/state.ts` – definición del estado de conversación.
- `src/dialogue/manager.ts` – lógica de flujo (qué se pregunta, cómo se avanza).
- `src/blindsbook/appointmentsClient.ts` – cliente HTTP hacia la API de BlindsBook (`/appointments`).
- `src/models/appointments.ts` – tipos de la cita compatibles con el backend actual.

## Requisitos

- Node.js `>= 24.13.0`
- Cuenta de Twilio con número de teléfono de voz.
- API de BlindsBook accesible (por ejemplo, `http://localhost:3000` en desarrollo).

## Instalación

```bash
cd "D:\Disco E trabajos\Crear IA de recepcionista"
npm install
```

## Configuración

1. Copia el archivo de ejemplo de entorno:

```bash
cp .env.example .env   # En Windows puedes copiarlo manualmente
```

2. Rellena en `.env`:
   - `TWILIO_AUTH_TOKEN` – token de Twilio para validar firmas (opcional pero recomendable).
   - `BLINDSBOOK_API_BASE_URL` – normalmente `http://localhost:3000` en desarrollo.
   - `BLINDSBOOK_API_TOKEN` – token o JWT de servicio con permisos para crear citas.
   - Opcionalmente `AI_SERVICE_URL` y `AI_SERVICE_API_KEY` si conectas un motor de IA externo.

## Ejecución en desarrollo

```bash
npm run dev
```

El servicio escuchará por defecto en `http://localhost:4000` y expondrá:

- `GET /health` – chequeo de salud.
- `POST /twilio/voice-webhook` – webhook que debes configurar en Twilio para el número de teléfono.

## Configuración en Twilio

1. Crea o usa un **número de teléfono de voz** en Twilio.
2. En la sección de configuración de ese número, en *A Call Comes In* selecciona:
   - Tipo: `Webhook` / `HTTP POST`.
   - URL: `https://TU_DOMINIO_PUBLICO/twilio/voice-webhook` (en desarrollo puedes usar ngrok o similar).
3. Guarda los cambios.

## Integración con BlindsBook

Este servicio llama al endpoint existente `POST /appointments` de la API de BlindsBook, enviando un `CreateAppointmentPayload` compatible con el DTO actual (`CreateAppointmentDto`). La lógica de citas (tablas `[Schedule].[Events]` y `[Schedule].[Appointments]`) sigue estando centralizada en el backend de BlindsBook.

En esta primera versión el flujo conversacional:

- Pregunta por el **tipo de cita** (cotización, instalación, reparación).
- Pide el **nombre del cliente** (en esta versión se guarda en memoria; en una siguiente iteración se puede resolver contra la API de clientes para obtener `customerId` real).
- Pide **fecha y hora** y asume una duración estándar de 1 hora (configurable).
- Llama a la API de BlindsBook para crear la cita.

Puedes extender `src/dialogue/manager.ts` para usar un servicio de IA externo (`AI_SERVICE_URL`) que interprete mejor las frases del cliente (extracción de fechas, nombres, etc.) y complete los campos necesarios respetando las reglas de negocio de BlindsBook.

