# MindAct -- Windows one-shot setup
# Run: Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
#      .\setup.ps1
param()
$ErrorActionPreference = "Stop"

function ok($msg)   { Write-Host "[OK]  $msg" -ForegroundColor Green }
function warn($msg) { Write-Host "[!!]  $msg" -ForegroundColor Yellow }
function die($msg)  { Write-Host "[ERR] $msg" -ForegroundColor Red; exit 1 }

$REPO = "KeploreAI-Lab/MindAct"

Write-Host "======================================"
Write-Host "  MindAct -- Windows Setup"
Write-Host "======================================"

# -- 1. Bun -------------------------------------------------------
Write-Host ""
Write-Host "Checking Bun..."
$bunBin = "$env:USERPROFILE\.bun\bin"
$env:PATH = "$bunBin;$env:PATH"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    warn "Bun not found -- installing..."
    & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
    $env:PATH = "$bunBin;$env:PATH"
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        die "Bun install failed. Install manually: https://bun.sh"
    }
    ok "Bun installed"
} else {
    ok "Bun $(bun --version)"
}

# -- 2. Node.js ---------------------------------------------------
Write-Host ""
Write-Host "Checking Node.js..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    die "Node.js >=18 is required. Install from https://nodejs.org"
}
$nodeVer = node -e "process.stdout.write(String(process.versions.node.split('.')[0]))"
if ([int]$nodeVer -lt 18) {
    die "Node.js >=18 required (found $(node --version)). Update at https://nodejs.org"
}
ok "Node.js $(node --version)"

# -- 3. Rust/Cargo ------------------------------------------------
Write-Host ""
Write-Host "Checking Rust/Cargo..."
$cargoBin = "$env:USERPROFILE\.cargo\bin"
if (-not (Test-Path $cargoBin)) {
    New-Item -ItemType Directory -Path $cargoBin -Force | Out-Null
}
$env:PATH = "$cargoBin;$env:PATH"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    warn "Rust/Cargo not found -- installing via rustup..."
    $rustupUrl = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
    $rustupExe = Join-Path $env:TEMP "rustup-init.exe"
    Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupExe -UseBasicParsing
    & $rustupExe -y | Out-Null
    $env:PATH = "$cargoBin;$env:PATH"
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        die "Rust install failed. Install manually: https://www.rust-lang.org/tools/install"
    }
    ok "Rust installed"
} else {
    ok "Cargo $(cargo --version)"
}

# -- 4. Get/build physmind.exe ------------------------------------
Write-Host ""
Write-Host "Downloading physmind.exe (pre-built by GitHub CI)..."

$dest = "$cargoBin\physmind.exe"

# Get the latest successful workflow run artifact download URL
$headers = @{ "Accept" = "application/vnd.github+json"; "X-GitHub-Api-Version" = "2022-11-28" }

try {
    $runs = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/actions/runs?status=success&branch=main&per_page=5" -Headers $headers
    $runId = $null
    foreach ($run in $runs.workflow_runs) {
        if ($run.name -eq "Build CLI (Windows)") {
            $runId = $run.id
            break
        }
    }
    if (-not $runId) {
        # Try any successful run
        $runId = $runs.workflow_runs[0].id
    }

    $artifacts = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/actions/runs/$runId/artifacts" -Headers $headers
    $artifact = $artifacts.artifacts | Where-Object { $_.name -eq "physmind-windows-x64" } | Select-Object -First 1

    if ($artifact) {
        warn "GitHub artifact requires authentication to download directly."
        warn "Downloading via gh CLI if available, or direct release asset..."
    }
} catch {
    warn "Could not query GitHub API: $_"
}

# Simpler: download from releases if available, else guide user
$releaseUrl = "https://github.com/$REPO/releases/download/latest-windows/physmind.exe"
Write-Host "  Trying latest release: $releaseUrl"
try {
    Invoke-WebRequest -Uri $releaseUrl -OutFile $dest -UseBasicParsing
    ok "physmind.exe downloaded to $dest"
} catch {
    warn "No release binary found. Building physmind.exe from source..."
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
    $cliDir = Join-Path $root "cli\rust"
    if (-not (Test-Path $cliDir)) {
        die "cli\rust not found. Did you clone with --recurse-submodules?"
    }
    try {
        Push-Location $cliDir
        cargo build --release -p rusty-claude-cli
        Pop-Location
        $built = Join-Path $cliDir "target\release\physmind.exe"
        if (-not (Test-Path $built)) {
            die "Build finished but $built not found."
        }
        Copy-Item -Force $built $dest
        ok "physmind.exe built and copied to $dest"
    } catch {
        warn "Failed to build physmind.exe. Ensure Visual Studio C++ Build Tools is installed."
        Write-Host ""
        Write-Host "  You can still continue without the embedded terminal, but terminal will not work until physmind.exe is available."
        Write-Host "  Manual build:"
        Write-Host "    cd .\cli\rust"
        Write-Host "    cargo build --release -p rusty-claude-cli"
        Write-Host "    copy .\target\release\physmind.exe $cargoBin\physmind.exe"
        Write-Host ""
        $skip = Read-Host "Press Enter to continue setup without CLI, or Ctrl+C to abort"
    }
}

# -- 5. Git submodule ---------------------------------------------
Write-Host ""
Write-Host "Initialising submodule..."
git submodule update --init --recursive
ok "Submodule ready"

# -- 6. Root dependencies -----------------------------------------
Write-Host ""
Write-Host "Installing root dependencies..."
bun install
ok "Root dependencies installed"

# -- 7. Build client ----------------------------------------------
Write-Host ""
Write-Host "Building client..."
Push-Location client
bun install
bun run build
Pop-Location
ok "Client built"

# -- Done ---------------------------------------------------------
Write-Host ""
Write-Host "======================================"
ok "Setup complete!"
Write-Host ""
Write-Host "  Launch the app:  .\restart.ps1"
Write-Host "======================================"
