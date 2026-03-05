# Integración ACS + Voice Live API (producción)

El canal de voz en producción utiliza **Azure Communication Services (ACS)** y **Azure AI Voice Live API**. El WebSocket actual `/ws/voice` sigue siendo la interfaz del agente de voz; ACS se conecta a él mediante un puente.

## Arquitectura

- **ACS Call Automation** establece la llamada y abre **streaming de audio bidireccional** hacia una URL WebSocket que exponemos. El formato de audio suele ser PCM 24 kHz (ver SDK).
- **Nuestro backend** puede:
  - **Opción A (puente):** Recibir el stream de ACS, reenviar el audio a **Voice Live API** (WebSocket), recibir audio/eventos de Voice Live y reenviar el audio a ACS. La conversación y TTS/STT viven en Voice Live; nosotros inyectamos contexto y gestionamos BlindsBook (p. ej. function calling para crear citas con `userId` correcto).
  - **Opción B (stack actual):** Recibir el stream de ACS, convertir a PCM 16 kHz si hace falta, enviar a nuestro pipeline actual `/ws/voice` (Azure STT → gestor de diálogo → Azure TTS). No se usa Voice Live; mantenemos el control del diálogo.

Para mínima latencia y voces más naturales, se recomienda la Opción A (Voice Live). La Opción B reutiliza la implementación actual sin nuevos servicios.

## Responsabilidades del puente (Opción A)

1. **Servidor WebSocket** al que se conecta ACS (protegido con JWT cuando sea posible).
2. **Resampling:** ACS puede enviar 24 kHz; Voice Live acepta 16 o 24 kHz. Remuestrear según convenga (p. ej. 24→24 o 16→24 en Node).
3. **Cliente Voice Live:** Conectar a `wss://<recurso>.services.ai.azure.com/voice-live/realtime?api-version=2025-10-01&model=<modelo>`. Enviar `session.update` con `turn_detection` (p. ej. `azure_semantic_vad_multilingual` para ES), `input_audio_noise_reduction`, `input_audio_echo_cancellation` y `voice` (p. ej. voz HD, temperature 0.8).
4. **BlindsBook:** Cuando el agente decida crear una cita (p. ej. por function/tool call desde Voice Live), el puente llamará a nuestra integración BlindsBook existente con `userId` = account manager del cliente identificado para que la cita aparezca en el schedule correcto.

## Simulador (solo local)

El simulador web de llamada está en `public/` y se sirve en `/test` (p. ej. `/test/voice-test-v2.html`). Es **solo para desarrollo y pruebas locales**.

- **Desactivar en producción:** Definir `VOICE_SIMULATOR_ENABLED=false`. La ruta estática `/test` no se registrará y el simulador no quedará expuesto.
- **Por defecto:** Si `VOICE_SIMULATOR_ENABLED` no está definido o es `true`, el simulador está disponible (p. ej. para uso local).

## Referencias

- [Crear agentes de voz de nueva generación (ACS + Voice Live)](https://techcommunity.microsoft.com/blog/azurecommunicationservicesblog/create-next-gen-voice-agents-with-azure-ais-voice-live-api-and-azure-communicati/4414735)
- [Resumen de Voice Live API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live)
- [Cómo usar Voice Live API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)
- [Call Center Voice Agent Accelerator](https://github.com/Azure-Samples/call-center-voice-agent-accelerator)
- [Protocolo WebSocket de voz](VOICE_WEBSOCKET_PROTOCOL.md) (contrato de `/ws/voice`)
