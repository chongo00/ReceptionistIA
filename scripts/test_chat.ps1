# Chat test script (POST /debug/chat)
# Requires service running at http://localhost:4000

$baseUrl = "http://localhost:4000"
$callId = "test-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

Write-Host "=== RecepcionistIA Chat Test ===" -ForegroundColor Cyan
Write-Host "CallId: $callId" -ForegroundColor Gray
Write-Host ""

function Invoke-ChatTurn {
    param([string]$text)
    
    $body = @{
        callId = $callId
        text = $text
    } | ConvertTo-Json
    
    try {
        $response = Invoke-RestMethod -Uri "$baseUrl/debug/chat" -Method POST -Body $body -ContentType "application/json"
        
        Write-Host "User: $text" -ForegroundColor Yellow
        Write-Host "AI: $($response.replyText)" -ForegroundColor Green
        Write-Host "State: $($response.state.step)" -ForegroundColor Gray
        Write-Host "Customer ID: $($response.state.customerId)" -ForegroundColor Gray
        Write-Host "Type: $($response.state.type)" -ForegroundColor Gray
        Write-Host "---" -ForegroundColor DarkGray
        Write-Host ""
        
        return $response
    } catch {
        Write-Host "Error: $_" -ForegroundColor Red
        return $null
    }
}

# Full test flow
Write-Host "1. Selecting language (1=Spanish)..." -ForegroundColor Cyan
$r1 = Invoke-ChatTurn "1"
Start-Sleep -Seconds 1

Write-Host "2. Selecting appointment type (quote)..." -ForegroundColor Cyan
$r2 = Invoke-ChatTurn "cotización"
Start-Sleep -Seconds 1

Write-Host "3. Providing customer name/phone..." -ForegroundColor Cyan
$r3 = Invoke-ChatTurn "John Doe"
Start-Sleep -Seconds 1

Write-Host "4. Providing date..." -ForegroundColor Cyan
$r4 = Invoke-ChatTurn "mañana a las 10"
Start-Sleep -Seconds 1

Write-Host "5. Confirming time..." -ForegroundColor Cyan
$r5 = Invoke-ChatTurn "10 de la mañana"
Start-Sleep -Seconds 1

Write-Host "6. Confirming duration..." -ForegroundColor Cyan
$r6 = Invoke-ChatTurn "está bien"
Start-Sleep -Seconds 1

Write-Host "=== Final Summary ===" -ForegroundColor Cyan
Write-Host "Final state: $($r6.state.step)" -ForegroundColor Yellow
Write-Host "CustomerId: $($r6.state.customerId)" -ForegroundColor Yellow
Write-Host "Type: $($r6.state.type)" -ForegroundColor Yellow
Write-Host "Duration: $($r6.state.duration)" -ForegroundColor Yellow
