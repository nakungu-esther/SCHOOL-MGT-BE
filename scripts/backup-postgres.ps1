param(
  [string]$ContainerName = "schoolmgtbe-db-1",
  [string]$OutDir = ".\backups"
)

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outFile = Join-Path $OutDir "edumanage-$timestamp.sql"

Write-Host "Writing backup to $outFile"
docker exec $ContainerName pg_dump -U edumanage edumanage | Out-File -Encoding utf8 $outFile
Write-Host "Backup complete."
