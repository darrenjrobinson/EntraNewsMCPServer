#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Entra.news ingestion pipeline — PowerShell orchestration wrapper.

.DESCRIPTION
    Validates prerequisites, configures the environment, then invokes the
    Node.js ingestion pipeline (scripts/ingest.ts) to fetch all Entra.news
    issues, generate embeddings, and build the SQLite search database.

.PARAMETER Incremental
    Only fetch and process posts that are not already in the database.

.PARAMETER Issue
    Process a single issue number.

.PARAMETER DbPath
    Override the output database path (default: ./entra-news.db).

.PARAMETER SkipBuild
    Skip the TypeScript compilation step (use pre-built dist/).

.EXAMPLE
    ./scripts/ingest.ps1 -Incremental
    ./scripts/ingest.ps1 -Issue 42
    ./scripts/ingest.ps1 -DbPath C:\data\entra-news.db
#>

[CmdletBinding()]
param(
    [switch]$Incremental,
    [int]$Issue = 0,
    [string]$DbPath = '',
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Step([string]$Message) {
    Write-Host "▶ $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name. Please install it and try again."
    }
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
Write-Step 'Checking prerequisites…'
Assert-Command 'node'
Assert-Command 'npm'

$nodeVersion = (node --version).TrimStart('v')
$major, $minor = $nodeVersion.Split('.')[0..1]
if ([int]$major -lt 18) {
    throw "Node.js 18+ is required. Found: v$nodeVersion"
}
Write-Success "Node.js v$nodeVersion"

# ---------------------------------------------------------------------------
# OpenAI API key
# ---------------------------------------------------------------------------
if (-not $env:OPENAI_API_KEY) {
    throw 'OPENAI_API_KEY environment variable is not set. ' +
          'Export it before running this script: $env:OPENAI_API_KEY = "sk-..."'
}
Write-Success 'OPENAI_API_KEY detected'

# ---------------------------------------------------------------------------
# Working directory
# ---------------------------------------------------------------------------
$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {

# ---------------------------------------------------------------------------
# Install dependencies if needed
# ---------------------------------------------------------------------------
if (-not (Test-Path 'node_modules')) {
    Write-Step 'Installing npm dependencies…'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
}

# ---------------------------------------------------------------------------
# Build TypeScript
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Step 'Compiling TypeScript…'
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript compilation failed.' }
    Write-Success 'Compiled to dist/'
}

# ---------------------------------------------------------------------------
# Set environment variables
# ---------------------------------------------------------------------------
if ($DbPath) {
    $env:INGEST_DB_PATH = $DbPath
    Write-Step "Using custom DB path: $DbPath"
}

# ---------------------------------------------------------------------------
# Build arguments for the ingestion script
# ---------------------------------------------------------------------------
$IngestArgs = @('dist/scripts/ingest.js')
if ($Incremental) { $IngestArgs += '--incremental' }
if ($Issue -gt 0) { $IngestArgs += '--issue', [string]$Issue }

Write-Step "Running ingestion: node $($IngestArgs -join ' ')"

# ---------------------------------------------------------------------------
# Run the ingestion pipeline
# ---------------------------------------------------------------------------
node @IngestArgs

if ($LASTEXITCODE -ne 0) {
    throw 'Ingestion failed. Check output above for details.'
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
$OutputDb = if ($DbPath) { $DbPath } else { Join-Path $RepoRoot 'entra-news.db' }

if (Test-Path $OutputDb) {
    $FileSizeMB = [math]::Round((Get-Item $OutputDb).Length / 1MB, 2)
    Write-Success "Database ready: $OutputDb ($FileSizeMB MB)"
} else {
    Write-Warn 'Database file not found at expected path — check the logs above.'
}

} finally {
    Pop-Location
}
