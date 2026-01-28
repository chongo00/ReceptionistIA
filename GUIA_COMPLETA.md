# Guía Completa: Recepcionista IA con Voz Natural

Guía paso a paso para configurar y probar la recepcionista IA en **local con voz neuronal (Azure Speech)** y luego desplegarla en **producción en Azure**.

---

## 📋 Tabla de Contenidos

1. [Requisitos Previos](#requisitos-previos)
2. [Configuración Local (Paso a Paso)](#configuración-local-paso-a-paso)
3. [Configuración de Voz Neuronal (Azure Speech)](#configuración-de-voz-neuronal-azure-speech)
4. [Configuración de Twilio](#configuración-de-twilio)
5. [Primera Llamada de Prueba](#primera-llamada-de-prueba)
6. [Costos Detallados](#costos-detallados)
7. [Despliegue en Producción (Azure)](#despliegue-en-producción-azure)
8. [Troubleshooting](#troubleshooting)

---

## Requisitos Previos

- **Node.js >= 24.13.0** instalado
- **API BlindsBook** funcionando localmente (puerto 3000)
- **Cuenta de Azure** (para Speech Service - voz neuronal)
- **Cuenta de Twilio** (para llamadas telefónicas)
- **ngrok** instalado (para exponer webhook local)

---

## Configuración Local (Paso a Paso)

### Paso 1: Levantar la API de BlindsBook

En una terminal:

```bash
cd "D:\Disco E trabajos\repositorio_blindsbook\App-BlindsBook\api"
npm run dev
```

Verifica que responde:
- Swagger: `http://localhost:3000/api-docs`
- Health check: `http://localhost:3000/health` (si existe)

### Paso 2: Instalar y Configurar RecepcionistIA

```bash
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
npm install
```

### Paso 3: Configurar Variables de Entorno (`.env`)

Edita el archivo `.env` y completa:

#### 3.1) BlindsBook API (OBLIGATORIO)

```env
BLINDSBOOK_API_BASE_URL=http://localhost:3000
BLINDSBOOK_API_TOKEN=tu_jwt_aqui
```

**Cómo obtener el JWT:**
1. Inicia sesión en tu app web/móvil contra la API local
2. Abre DevTools (F12) → Network
3. Busca la petición `POST /auth/login`
4. Copia el token desde `response.data.token`
5. Pégalo en `BLINDSBOOK_API_TOKEN`

#### 3.2) Multi-Tenant (Opcional)

Si tienes múltiples compañías y números de Twilio:

```env
TWILIO_NUMBER_TO_COMPANY_MAP={"+15551234567":{"token":"jwt_compannia_1","companyId":387},"+15557654321":{"token":"jwt_compannia_2","companyId":2}}
```

**Cómo obtener JWT por compañía:**
1. Inicia sesión con un usuario de esa compañía
2. Copia el token desde `POST /auth/login → data.token`
3. Agrega la entrada al JSON con el número de Twilio correspondiente

### Paso 4: Iniciar RecepcionistIA

```bash
npm run dev
```

Verifica:
- `http://localhost:4000/health` devuelve `{"ok":true}`

---

## Configuración de Voz Neuronal (Azure Speech)

### Paso 1: Crear Recurso Speech en Azure

1. Ve a **Azure Portal**: `https://portal.azure.com`
2. **Crear un recurso** → Busca "Speech"
3. Selecciona **"Speech"** (Cognitive Services)
4. Configura:
   - **Suscripción**: Tu suscripción
   - **Grupo de recursos**: Crea uno nuevo o usa existente
   - **Región**: Elige una cercana (ej: `East US`, `West Europe`)
   - **Nombre**: `blindsbook-speech` (o el que prefieras)
   - **Plan de precios**: **Free F0** (para pruebas) o **Standard S0** (producción)
5. Clic en **"Revisar y crear"** → **"Crear"**

### Paso 2: Obtener Credenciales de Azure

1. Ve al recurso creado en Azure Portal
2. En **"Claves y punto de conexión"**:
   - Copia **Key 1** → `AZURE_SPEECH_KEY`
   - Copia **Ubicación/Región** → `AZURE_SPEECH_REGION` (ej: `eastus`, `westeurope`)

### Paso 3: Configurar ngrok (OBLIGATORIO para voz neuronal)

**¿Por qué ngrok?** Twilio necesita acceder públicamente a `/tts/*.mp3` para reproducir el audio generado por Azure.

1. **Instala ngrok:**
   - Descarga: `https://ngrok.com/download`
   - Extrae `ngrok.exe` en una carpeta (ej: `C:\ngrok\`)
   - O instala vía chocolatey: `choco install ngrok`

2. **Ejecuta ngrok** (en una terminal separada):

```bash
ngrok http 4000
```

3. **Copia la URL HTTPS** que te da (ej: `https://abcd-1234-5678.ngrok-free.app`)

### Paso 4: Configurar `.env` con Azure

Agrega estas variables a tu `.env`:

```env
# URL pública (ngrok en local / dominio en Azure)
PUBLIC_BASE_URL=https://TU-URL-NGROK

# Azure Speech (TTS neuronal)
AZURE_SPEECH_KEY=tu_key_de_azure
AZURE_SPEECH_REGION=eastus

# Voces neuronales (puedes cambiarlas)
AZURE_TTS_VOICE_ES=es-ES-ElviraNeural
AZURE_TTS_VOICE_EN=en-US-JennyNeural
```

**Voces disponibles en Azure:**
- **Español**: `es-ES-ElviraNeural`, `es-ES-AlvaroNeural`, `es-MX-DaliaNeural`
- **Inglés**: `en-US-JennyNeural`, `en-US-AriaNeural`, `en-US-GuyNeural`

Ver más: `https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts`

### Paso 5: Reiniciar RecepcionistIA

```bash
# Detén el proceso (Ctrl+C) y vuelve a iniciar:
npm run dev
```

**Nota:** Si Azure no está configurado o falla, el sistema hace **fallback automático** a la voz sintética de Twilio (`<Say>`).

---

## Configuración de Twilio

### Paso 1: Crear Cuenta de Twilio

1. Ve a: `https://www.twilio.com/try-twilio`
2. Regístrate con tu email (gratis)
3. Verifica tu número de teléfono (te envían un código SMS)
4. Twilio te dará:
   - **Account SID**
   - **Auth Token** (cópialo, lo necesitarás)
   - **Crédito de prueba** ($15-20 USD)

### Paso 2: Obtener Número de Teléfono

**Opción A (Trial - Recomendada para pruebas):**
- Twilio te da un número de prueba gratis
- Ve a **Phone Numbers** → **Manage** → Usa el número que ya tienes

**Opción B (Comprar número real):**
- Ve a **Phone Numbers** → **Buy a number**
- Selecciona país y tipo (Voice)
- Costo: ~$1 USD/mes

### Paso 3: Configurar Auth Token en `.env`

```env
TWILIO_AUTH_TOKEN=tu_auth_token_de_twilio
TWILIO_VALIDATE_SIGNATURE=false  # En local puedes poner false
```

**Dónde encontrarlo:**
- Twilio Console → **Account** → **Auth Token**

### Paso 4: Configurar Webhook en Twilio

1. En Twilio Console → **Phone Numbers** → Selecciona tu número
2. En **Voice & Fax** → **A Call Comes In**:
   - Selecciona: **Webhook**
   - Método: **HTTP POST**
   - URL: `https://TU-URL-NGROK/twilio/voice-webhook`
     - Ejemplo: `https://abcd-1234-5678.ngrok-free.app/twilio/voice-webhook`
3. **Guarda** los cambios

---

## Primera Llamada de Prueba

### Checklist Antes de Llamar

- [ ] API BlindsBook corriendo (`http://localhost:3000`)
- [ ] RecepcionistIA corriendo (`npm run dev`)
- [ ] ngrok corriendo (`ngrok http 4000`)
- [ ] `.env` configurado con:
  - [ ] `BLINDSBOOK_API_TOKEN`
  - [ ] `PUBLIC_BASE_URL` (URL de ngrok)
  - [ ] `AZURE_SPEECH_KEY` y `AZURE_SPEECH_REGION`
  - [ ] `TWILIO_AUTH_TOKEN`
- [ ] Webhook configurado en Twilio

### Hacer la Llamada

1. **Llama al número de Twilio** desde tu móvil
2. **Deberías escuchar:**
   - "Para español, presione 1. For English, press 2."
   - Presiona `1` o di "español"
   - Sigue el flujo:
     - Tipo de cita (cotización, instalación, reparación)
     - Nombre del cliente
     - Fecha
     - Hora
     - Duración
3. **Al finalizar**, la cita se crea automáticamente en BlindsBook

### Verificar que Funcionó

**Consulta SQL:**

```bash
sqlcmd -S "localhost\SQLEXPRESS" -d "db_blindTest" -E -Q "SET NOCOUNT ON; SELECT TOP 3 a.Id, a.CustomerId, a.Type, e.Start, e.UserId FROM [Schedule].[Appointments] a JOIN [Schedule].[Events] e ON e.Id=a.Id ORDER BY a.Id DESC;"
```

Deberías ver la nueva cita creada con `CustomerId`, `Type`, `Start`, etc.

---

## Costos Detallados

### Twilio

#### Cuenta Trial (Gratis para empezar)

- **Crédito inicial:** $15-20 USD (varía por región)
- **Duración:** Ilimitada (pero crédito se acaba cuando lo uses)
- **Límites:**
  - Solo puedes llamar a números verificados en tu cuenta
  - El número de prueba puede tener restricciones

#### Producción (Después del Trial)

| Concepto | Costo |
|----------|-------|
| **Número de teléfono** | ~$1 USD/mes (varía por país) |
| **Llamadas entrantes** | ~$0.0085-0.05 USD/minuto (según país) |
| **Llamadas salientes** | ~$0.01-0.05 USD/minuto |
| **Reconocimiento de voz (Gather)** | Incluido en el precio de la llamada |

**Ejemplo mensual estimado:**
- 100 llamadas de 5 minutos = 500 minutos
- 500 minutos × $0.01/min = **$5 USD/mes** (aproximado)

**Precios actuales:** `https://www.twilio.com/voice/pricing`

### Azure Speech (TTS Neuronal)

#### Plan Free (F0) - Para Pruebas

| Concepto | Límite Gratis |
|----------|---------------|
| **Síntesis de voz (TTS)** | 0.5 millones de caracteres/mes |
| **Reconocimiento de voz (STT)** | 5 horas/mes |
| **Duración:** | 12 meses (luego necesitas plan de pago) |

#### Plan Standard (S0) - Producción

| Concepto | Costo |
|----------|-------|
| **Síntesis de voz (TTS)** | $4 USD por millón de caracteres |
| **Reconocimiento de voz (STT)** | $1 USD por hora de audio |

**Ejemplo mensual estimado:**
- 100 llamadas de 5 minutos
- Cada llamada: ~500 caracteres de texto generado
- Total: 50,000 caracteres
- Costo: 50,000 / 1,000,000 × $4 = **$0.20 USD/mes**

**Precios actuales:** `https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/`

### ngrok

- **Plan gratuito:** URL cambia cada vez que reinicias (aceptable para pruebas)
- **Plan pago:** URL fija desde ~$8 USD/mes (útil para desarrollo continuo)
- **En producción:** No necesitas ngrok (usas dominio de Azure)

### Resumen de Costos Mensuales (Producción)

| Servicio | Costo Estimado |
|----------|----------------|
| **Twilio** (100 llamadas de 5 min) | ~$5 USD |
| **Azure Speech** (TTS neuronal) | ~$0.20 USD |
| **Número Twilio** | ~$1 USD |
| **Azure App Service** (hosting) | ~$13-55 USD/mes (según plan) |
| **TOTAL** | **~$19-61 USD/mes** |

---

## Despliegue en Producción (Azure)

### Paso 1: Preparar Azure App Service

1. En Azure Portal → **App Services** → **Crear**
2. Configura:
   - **Suscripción**: Tu suscripción
   - **Grupo de recursos**: Crea o usa existente
   - **Nombre**: `blindsbook-receptionist-ai` (o el que prefieras)
   - **Publicar**: Código
   - **Pila de runtime**: Node.js 24 LTS
   - **Sistema operativo**: Linux (recomendado) o Windows
   - **Plan**: Básico B1 (mínimo) o superior
3. Clic en **"Revisar y crear"** → **"Crear"**

### Paso 2: Configurar Variables de Entorno en Azure

1. Ve a tu App Service → **Configuración** → **Variables de aplicación**
2. Agrega todas las variables de tu `.env`:

```
BLINDSBOOK_API_BASE_URL=https://tu-api-blindsbook.azurewebsites.net
BLINDSBOOK_API_TOKEN=tu_jwt_de_produccion
TWILIO_AUTH_TOKEN=tu_twilio_auth_token
TWILIO_VALIDATE_SIGNATURE=true
PUBLIC_BASE_URL=https://blindsbook-receptionist-ai.azurewebsites.net
AZURE_SPEECH_KEY=tu_key_de_azure
AZURE_SPEECH_REGION=eastus
AZURE_TTS_VOICE_ES=es-ES-ElviraNeural
AZURE_TTS_VOICE_EN=en-US-JennyNeural
TWILIO_NUMBER_TO_COMPANY_MAP={"+15551234567":{"token":"jwt1","companyId":387}}
```

3. **Guarda** los cambios

### Paso 3: Desplegar Código

**Opción A: Azure CLI**

```bash
# Instala Azure CLI si no lo tienes
# Luego:
az login
az webapp up --name blindsbook-receptionist-ai --resource-group tu-resource-group --runtime "NODE:24-lts"
```

**Opción B: GitHub Actions / Azure DevOps**

Crea un pipeline que:
1. Hace `npm run build`
2. Despliega `dist/` a Azure App Service

**Opción C: Visual Studio Code**

1. Instala extensión "Azure App Service"
2. Clic derecho en carpeta del proyecto → **Deploy to Web App**

### Paso 4: Configurar Dominio HTTPS

Azure App Service ya incluye HTTPS con certificado gratuito:
- URL: `https://blindsbook-receptionist-ai.azurewebsites.net`

Si quieres dominio personalizado:
1. App Service → **Dominios personalizados**
2. Agrega tu dominio y configura DNS

### Paso 5: Actualizar Webhook en Twilio

1. Ve a Twilio Console → **Phone Numbers** → Tu número
2. Actualiza **A Call Comes In**:
   - URL: `https://blindsbook-receptionist-ai.azurewebsites.net/twilio/voice-webhook`
3. **Guarda**

### Paso 6: Verificar Despliegue

1. Verifica health check:
   - `https://blindsbook-receptionist-ai.azurewebsites.net/health`
2. Revisa logs:
   - App Service → **Registros** → **Registros de aplicación**
3. Haz una llamada de prueba

### Paso 7: Configurar Escalado (Opcional)

Si esperas muchas llamadas simultáneas:

1. App Service → **Escalar verticalmente (plan de App Service)**
2. Selecciona un plan superior (Standard S1, Premium P1, etc.)
3. O configura **Escalar horizontalmente** (múltiples instancias)

---

## Troubleshooting

### "No puedo recibir llamadas"

**Síntomas:** La llamada se corta inmediatamente o no suena nada.

**Soluciones:**
1. Verifica que RecepcionistIA esté corriendo (`npm run dev`)
2. Verifica que ngrok esté corriendo y la URL sea accesible
3. Verifica que el webhook en Twilio apunte a la URL correcta
4. Revisa logs de RecepcionistIA para ver si llegan peticiones
5. Revisa Twilio Console → **Monitor** → **Logs** → **Calls**

### "La voz suena robótica (no neuronal)"

**Síntomas:** Escuchas voz sintética en vez de voz natural.

**Soluciones:**
1. Verifica que `AZURE_SPEECH_KEY` y `AZURE_SPEECH_REGION` estén configurados
2. Verifica que `PUBLIC_BASE_URL` esté configurado (ngrok en local / dominio en Azure)
3. Revisa logs de RecepcionistIA para ver si hay errores de Azure TTS
4. Si Azure falla, el sistema hace fallback a `Say` (voz sintética)

### "No encuentra clientes"

**Síntomas:** La IA dice que no encuentra el cliente aunque existe.

**Soluciones:**
1. Verifica que `BLINDSBOOK_API_TOKEN` sea válido y no haya expirado
2. Verifica que el cliente exista en la compañía del JWT usado
3. Verifica que la API BlindsBook esté corriendo y accesible
4. Revisa logs de RecepcionistIA para ver errores de API

### "Error al crear cita"

**Síntomas:** La conversación termina pero no se crea la cita.

**Soluciones:**
1. Verifica que `BLINDSBOOK_API_TOKEN` tenga permisos para crear citas
2. Verifica que `customerId` esté resuelto correctamente
3. Revisa logs de RecepcionistIA para ver errores de creación
4. Verifica en SQL que la cita no se haya creado con datos incorrectos

### "ngrok URL cambia cada vez"

**Síntomas:** Tienes que actualizar el webhook en Twilio cada vez que reinicias ngrok.

**Soluciones:**
1. **Opción A:** Usa plan pago de ngrok (~$8 USD/mes) para URL fija
2. **Opción B:** Usa Cloudflare Tunnel (gratis, URL fija)
3. **Opción C:** Despliega a Azure directamente (no necesitas ngrok)

### "Azure Speech cuota excedida"

**Síntomas:** Error 429 (Too Many Requests) al sintetizar voz.

**Soluciones:**
1. Verifica tu plan de Azure Speech (Free F0 tiene límites)
2. Si estás en Free, considera pasar a Standard S0
3. Revisa uso en Azure Portal → Tu recurso Speech → **Métricas**

---

## Modo Pruebas 100% Gratis (Sin Twilio)

Si quieres probar el flujo sin pagar nada ni configurar Twilio:

**Endpoint local de chat:**

```bash
POST http://localhost:4000/debug/chat
Content-Type: application/json

{
  "callId": "test1",
  "text": "1"
}
```

Luego envías más turnos con el mismo `callId`:

```json
{ "callId": "test1", "text": "cotización" }
{ "callId": "test1", "text": "Juan Pérez" }
{ "callId": "test1", "text": "mañana" }
{ "callId": "test1", "text": "10:00" }
```

Esto te permite validar el flujo y la integración con la API sin llamadas reales.

---

## Checklist Final

### Para Pruebas Locales

- [ ] API BlindsBook corriendo
- [ ] RecepcionistIA corriendo
- [ ] ngrok corriendo
- [ ] `.env` configurado completamente
- [ ] Twilio configurado (webhook + número)
- [ ] Azure Speech configurado (opcional pero recomendado)
- [ ] Primera llamada de prueba exitosa
- [ ] Cita creada verificada en SQL

### Para Producción en Azure

- [ ] App Service creado y desplegado
- [ ] Variables de entorno configuradas en Azure
- [ ] Dominio HTTPS configurado
- [ ] Webhook de Twilio actualizado a URL de producción
- [ ] Validación de firma Twilio activada (`TWILIO_VALIDATE_SIGNATURE=true`)
- [ ] Logs monitoreados
- [ ] Pruebas de carga realizadas (opcional)

---

**¿Necesitas ayuda?** Revisa los logs de RecepcionistIA, Twilio Console y Azure Portal para diagnosticar problemas.
