$ErrorActionPreference = 'Stop'

$secureKey = Read-Host 'Paste the new Lantern project ingest key' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
  $env:COLLECTOR_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if (-not $env:LANTERN_COLLECTOR_URL) {
    $env:LANTERN_COLLECTOR_URL = 'http://localhost:3000'
  }
  node (Join-Path $PSScriptRoot 'server.js')
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Item Env:COLLECTOR_API_KEY -ErrorAction SilentlyContinue
}
