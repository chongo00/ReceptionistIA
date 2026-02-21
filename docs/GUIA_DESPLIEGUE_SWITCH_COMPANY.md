# Guía de Despliegue — Receptionist IA + Switch-Company

## Resumen de Cambios Realizados

### 1. Endpoint `POST /api/auth/switch-company` (API BlindsBook - NestJS)

**Archivos modificados en `App-BlindsBook/api/`:**

| Archivo | Cambio |
|---------|--------|
| `src/modules/auth/dto/switch-company.dto.ts` | **NUEVO** — DTO con validación `{ companyId: number }` |
| `src/modules/auth/auth.service.ts` | Método `switchCompany()` — verifica IsSuperUser, genera nuevo JWT con el companyId target |
| `src/modules/auth/auth.controller.ts` | Endpoint `POST /auth/switch-company` protegido con JwtAuthGuard |
| `src/modules/team/team.service.ts` | **BUG FIX** — invite guardaba passwords en texto plano, ahora usa bcrypt |

**Lógica del switch-company:**
1. Requiere JWT válido (autenticación)
2. Verifica que el usuario tenga `IsSuperUser = 1` en `[User].Users`
3. Verifica que la compañía target exista y esté activa
4. Genera un nuevo JWT con el `companyId` de la compañía target
5. No modifica la BD (a diferencia del .NET que cambiaba el CompanyId del usuario)

### 2. TokenManager con switch-company (Receptionist IA)

**Archivos modificados en `Receptionist IA/`:**

| Archivo | Cambio |
|---------|--------|
| `src/blindsbook/tokenManager.ts` | Soporte para switch-company: `doSwitchCompany()`, `switchCompanyTargets`, renovación proactiva por compañía |
| `src/blindsbook/appointmentsClient.ts` | Sin cambios adicionales (ya usaba TokenManager) |
| `src/config/env.ts` | Sin cambios adicionales |
| `.env` | Credenciales del superusuario charlie + mapa Twilio con 3 compañías |

**Flujo del TokenManager:**
1. Login como superusuario (`carconval@gmail.com` / `charlie`) → JWT base (companyId 163)
2. Para cada compañía sin credenciales propias → `POST /api/auth/switch-company { companyId }` → JWT específico
3. Renovación proactiva cada 30 min: renueva el token del superusuario primero, luego switch-company por cada compañía

### 3. Cuenta superusuario

- **Email:** `carconval@gmail.com`
- **Username:** `charlie`
- **Password:** `charlie` (hash bcrypt actualizado en Azure)
- **IsSuperUser:** `1`
- **CompanyId nativa:** `163` (Sophie Blinds LLC)

---

## Paso 1: Desplegar API BlindsBook en Azure

El endpoint `switch-company` necesita estar desplegado en Azure para que Receptionist IA lo use.

```bash
# Desde App-BlindsBook/api/

# Opción A: Si hay pipeline CI/CD (ado-deploy-api.yml)
git add -A
git commit -m "feat(auth): add POST /auth/switch-company for superuser multi-tenant"
git push origin main   # o la rama que dispare el pipeline

# Opción B: Docker manual
docker build -t blindsbook-api:latest .
docker tag blindsbook-api:latest <ACR_NAME>.azurecr.io/blindsbook-api:latest
docker push <ACR_NAME>.azurecr.io/blindsbook-api:latest
```

### Verificar que el deploy funcionó:

```powershell
# 1. Login como charlie
$body = '{"email":"carconval@gmail.com","password":"charlie"}'
$r = Invoke-WebRequest -Uri "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/auth/login" -Method POST -ContentType "application/json" -Body $body -UseBasicParsing
$token = ($r.Content | ConvertFrom-Json).data.token
Write-Host "Token: $($token.Substring(0,50))..."

# 2. Switch a company 2 (All Blinds Inc)
$r2 = Invoke-WebRequest -Uri "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/auth/switch-company" -Method POST -ContentType "application/json" -Body '{"companyId":2}' -Headers @{"Authorization"="Bearer $token"} -UseBasicParsing
$r2.Content | ConvertFrom-Json | ConvertTo-Json -Depth 5

# 3. Buscar clientes de esa compañía
$token2 = ($r2.Content | ConvertFrom-Json).data.token
$r3 = Invoke-WebRequest -Uri "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/customers?page=1&pageSize=3" -Headers @{"Authorization"="Bearer $token2"} -UseBasicParsing
$r3.Content | ConvertFrom-Json | ConvertTo-Json -Depth 5
```

---

## Paso 2: Construir imagen Docker de Receptionist IA

```powershell
cd "d:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"

# ─── Opción A: Solo Node.js (sin Ollama) ───
docker build -t receptionist-ia:latest -f Dockerfile .

# ─── Opción B: Contenedor unificado (Node.js + Ollama + qwen2.5:3b) ───
# ⚠ La primera vez tarda 10-60+ min por la descarga del modelo (~2GB)
docker build -t receptionist-ia-unified:latest -f Dockerfile.unified .
```

---

## Paso 3: Ejecutar con docker-compose

```powershell
cd "d:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"

# Configurar las variables de entorno (o editar .env):
$env:BLINDSBOOK_API_BASE_URL = "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io"
$env:BLINDSBOOK_LOGIN_EMAIL = "carconval@gmail.com"
$env:BLINDSBOOK_LOGIN_PASSWORD = "charlie"
$env:TWILIO_NUMBER_TO_COMPANY_MAP = '{"` + `+15550000001":{"companyId":2},"+15550000002":{"companyId":163},"+15550000003":{"companyId":387}}'

# Construir y levantar
docker-compose up --build -d

# Ver logs
docker-compose logs -f blindsbook-ia
```

### Variables de entorno clave:

| Variable | Valor | Descripción |
|----------|-------|-------------|
| `BLINDSBOOK_API_BASE_URL` | `https://blindsbook-mobile-api-test...` | URL del API en Azure |
| `BLINDSBOOK_LOGIN_EMAIL` | `carconval@gmail.com` | Superusuario para auto-login |
| `BLINDSBOOK_LOGIN_PASSWORD` | `charlie` | Password del superusuario |
| `TWILIO_NUMBER_TO_COMPANY_MAP` | JSON con companyId por número | Ver .env para formato |

---

## Paso 4: Probar sin Docker (desarrollo local)

```powershell
cd "d:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"

# Instalar dependencias
npm install

# Compilar
npm run build

# Ejecutar (usa .env automáticamente)
npm start

# En otra terminal, probar:
# Compañía 2 (All Blinds Inc)
Invoke-WebRequest -Uri "http://localhost:4000/debug/chat" -Method POST -ContentType "application/json" -Body '{"callId":"test-co2","text":"hola","toNumber":"+15550000001"}' -UseBasicParsing | Select-Object -ExpandProperty Content

# Compañía 163 (Sophie Blinds LLC)
Invoke-WebRequest -Uri "http://localhost:4000/debug/chat" -Method POST -ContentType "application/json" -Body '{"callId":"test-co163","text":"hola","toNumber":"+15550000002"}' -UseBasicParsing | Select-Object -ExpandProperty Content

# Compañía 387 (Miami's Best Blinds)
Invoke-WebRequest -Uri "http://localhost:4000/debug/chat" -Method POST -ContentType "application/json" -Body '{"callId":"test-co387","text":"hola","toNumber":"+15550000003"}' -UseBasicParsing | Select-Object -ExpandProperty Content
```

---

## Logs esperados al iniciar

```
[TokenManager] Compañía 2 registrada (switch-company via superusuario)
[TokenManager] Compañía 163 registrada (switch-company via superusuario)
[TokenManager] Compañía 387 registrada (switch-company via superusuario)
[Auth] Iniciando TokenManager — auto-login para todas las compañías...
[TokenManager] Login default OK — token válido por 1440 min
[TokenManager] ✓ Login superusuario OK
[TokenManager] switch-company 2 OK — token válido por 1440 min
[TokenManager] ✓ Switch-company 2 OK
[TokenManager] switch-company 163 OK — token válido por 1440 min
[TokenManager] ✓ Switch-company 163 OK
[TokenManager] switch-company 387 OK — token válido por 1440 min
[TokenManager] ✓ Switch-company 387 OK
[TokenManager] Renovación proactiva activada (cada 30 min)
[Auth] TokenManager listo — tokens se renuevan automáticamente
🚗 Servicio IA recepcionista escuchando en puerto 4000
```

---

## Compañías de prueba

| CompanyId | Nombre | Clientes | Número Twilio (ejemplo) |
|-----------|--------|----------|------------------------|
| 2 | All Blinds Inc | 7,747 | +15550000001 |
| 163 | Sophie Blinds LLC | 7,022 | +15550000002 |
| 387 | Miami's Best Blinds | 1,258 | +15550000003 |

---

## Troubleshooting

### "switch-company 404"
El endpoint aún no está desplegado en Azure. Hacer deploy de `App-BlindsBook/api/` primero (Paso 1).

### "Login superusuario RECHAZADO (401)"
Verificar que el password de charlie en Azure sea bcrypt. Ejecutar:
```powershell
cd "d:\Disco E trabajos\repositorio_blindsbook\App-BlindsBook\api"
node -e "const sql=require('mssql'),bcrypt=require('bcrypt');(async()=>{const p=await sql.connect({server:'blindsbook-test.database.windows.net',database:'db_blindsbook-uat',user:'testmaster',password:'T530d5e5c5ee2c5d98b790e8e8989d22a',options:{encrypt:true}});const h=await bcrypt.hash('charlie',10);await p.request().input('h',sql.NVarChar,h).input('u',sql.NVarChar,'charlie').query('UPDATE [Identity].Users SET PasswordHash=@h WHERE UserName=@u');console.log('OK');await p.close();})()"
```

### "Only superusers can switch companies"
El usuario no tiene `IsSuperUser = 1` en `[User].Users`. Verificar:
```sql
SELECT Id, Username, Email, IsSuperUser FROM [User].Users WHERE Email = 'carconval@gmail.com'
```

### Token se renueva pero sigue 401
El token del superusuario base puede haber expirado mientras se hacía switch-company. El TokenManager lo maneja automáticamente (re-login + switch-company). Si persiste, verificar que las credenciales en .env sean correctas.
