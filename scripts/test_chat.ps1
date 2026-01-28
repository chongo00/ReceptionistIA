# Script de prueba por chat (POST /debug/chat)
# Requiere que el servicio esté corriendo en http://localhost:4000

$baseUrl = "http://localhost:4000"
$callId = "test-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

Write-Host "=== Prueba de RecepcionistIA por Chat ===" -ForegroundColor Cyan
Write-Host "CallId: $callId" -ForegroundColor Gray
Write-Host ""

# Función helper para hacer POST
function Invoke-ChatTurn {
    param([string]$text)
    
    $body = @{
        callId = $callId
        text = $text
    } | ConvertTo-Json
    
    try {
        $response = Invoke-RestMethod -Uri "$baseUrl/debug/chat" -Method POST -Body $body -ContentType "application/json"
        
        Write-Host "Usuario: $text" -ForegroundColor Yellow
        Write-Host "IA: $($response.replyText)" -ForegroundColor Green
        Write-Host "Estado: $($response.state.step)" -ForegroundColor Gray
        Write-Host "Cliente ID: $($response.state.customerId)" -ForegroundColor Gray
        Write-Host "Tipo: $($response.state.type)" -ForegroundColor Gray
        Write-Host "---" -ForegroundColor DarkGray
        Write-Host ""
        
        return $response
    } catch {
        Write-Host "Error: $_" -ForegroundColor Red
        return $null
    }
}

# Flujo de prueba completo
Write-Host "1. Seleccionando idioma (1=Español)..." -ForegroundColor Cyan
$r1 = Invoke-ChatTurn "1"
Start-Sleep -Seconds 1

Write-Host "2. Indicando tipo de cita (cotización)..." -ForegroundColor Cyan
$r2 = Invoke-ChatTurn "cotización"
Start-Sleep -Seconds 1

Write-Host "3. Dando nombre/teléfono del cliente..." -ForegroundColor Cyan
$r3 = Invoke-ChatTurn "John Doe"
Start-Sleep -Seconds 1

Write-Host "4. Indicando fecha..." -ForegroundColor Cyan
$r4 = Invoke-ChatTurn "mañana a las 10"
Start-Sleep -Seconds 1

Write-Host "5. Confirmando hora..." -ForegroundColor Cyan
$r5 = Invoke-ChatTurn "10 de la mañana"
Start-Sleep -Seconds 1

Write-Host "6. Confirmando duración..." -ForegroundColor Cyan
$r6 = Invoke-ChatTurn "está bien"
Start-Sleep -Seconds 1

Write-Host "=== Resumen final ===" -ForegroundColor Cyan
Write-Host "Estado final: $($r6.state.step)" -ForegroundColor Yellow
Write-Host "CustomerId: $($r6.state.customerId)" -ForegroundColor Yellow
Write-Host "Tipo: $($r6.state.type)" -ForegroundColor Yellow
Write-Host "Duración: $($r6.state.duration)" -ForegroundColor Yellow
