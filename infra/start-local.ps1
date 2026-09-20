$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    $dockerPath = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'
    if (Test-Path (Join-Path $dockerPath 'docker.exe')) { $env:PATH = "$dockerPath;$env:PATH" }
}
docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop with Linux containers first.' }
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }
docker compose --project-name gdm-local --env-file .env -f docker-compose.yml -f docker-compose.local.yml up -d --build --wait --wait-timeout 180
if ($LASTEXITCODE -ne 0) { throw 'Local stack failed to start. Inspect docker compose logs.' }
$settings = Invoke-RestMethod 'http://localhost:3001/api/settings'
$localPaths = @{}
foreach ($key in @('compensationUrl', 'noConsentUrl', 'ineligibleUrl', 'withdrawalUrl', 'unmatchedUrl', 'technicalFailureUrl')) {
    if (-not $settings.$key) { $localPaths[$key] = "http://localhost:3000/local-demo.html?complete=$key" }
}
if ($localPaths.Count -gt 0) {
    $body = @{ settings = $localPaths } | ConvertTo-Json
    Invoke-RestMethod 'http://localhost:3001/api/settings' -Method Put -ContentType 'application/json' -Body $body | Out-Null
}
Write-Host 'Local demo: http://localhost:3000/local-demo.html'
Write-Host 'Participant: http://localhost:3000 | Admin: http://localhost:3003'
Write-Host 'Anthropic and Prolific are mocked. No real payments or AI requests.'
