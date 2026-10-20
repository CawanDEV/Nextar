# This script runs on the tester's own Windows PC, never on the GitHub runner.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Test-DockerReady {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker info *> $null
        return ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $previousPreference }
}

function Set-NextarEnvValue([string]$Path, [string]$Key, [string]$Value) {
    $text = [System.IO.File]::ReadAllText($Path)
    $pattern = '(?m)^' + [regex]::Escape($Key) + '=[^\r\n]*'
    if ([regex]::IsMatch($text, $pattern)) { $text = [regex]::Replace($text, $pattern, ($Key + '=' + $Value)) }
    else { $text += "`r`n$Key=$Value`r`n" }
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}
function Find-NextarPort([int]$Preferred) {
    for ($candidate = $Preferred; $candidate -lt ($Preferred + 30); $candidate++) {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $candidate)
        try { $listener.Start(); return $candidate }
        catch [System.Net.Sockets.SocketException] { }
        finally { $listener.Stop() }
    }
    throw 'Nao foi encontrada uma porta livre. Feche outras instancias de teste e tente novamente.'
}
function Read-NextarPort([string]$Path, [string]$Key, [int]$Default) {
    $value = [regex]::Match([System.IO.File]::ReadAllText($Path), ('(?m)^' + $Key + '=(\d+)\s*$'))
    if ($value.Success) {
        $number = [int]$value.Groups[1].Value
        if ($number -ge 1024 -and $number -le 65000) { return $number }
    }
    return $Default
}

try {
    Write-Host 'NEXTAR - iniciar site e vendedor Telegram' -ForegroundColor Green
    Write-Host 'Nenhuma cobranca real. As compras de teste alteram seu estoque.'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Instale o Docker Desktop e execute este arquivo novamente. Nao e necessario instalar Node.js.'
    }
    if (-not (Test-DockerReady)) {
        $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (Test-Path -LiteralPath $desktop) { Start-Process -FilePath $desktop }
        Write-Host 'Aguardando o Docker Desktop ficar pronto...'
        $deadline = (Get-Date).AddMinutes(3)
        while (-not (Test-DockerReady)) {
            if ((Get-Date) -gt $deadline) { throw 'Abra o Docker Desktop e conclua a configuracao inicial; depois tente novamente.' }
            Start-Sleep -Seconds 3
        }
    }
    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose indisponivel. Atualize o Docker Desktop.' }

    # Update only a clean main checkout. ZIP downloads work without Git.
    if ((Test-Path -LiteralPath (Join-Path $root '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        $branch = & git branch --show-current
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel consultar a copia Git.' }
        $changes = & git status --porcelain
        if ($branch -eq 'main' -and -not $changes) {
            Write-Host 'Atualizando o projeto...'
            & git pull --ff-only
            if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel atualizar o projeto. Confira a internet e tente novamente.' }
        } else {
            Write-Host 'Usando os arquivos atuais; sua branch e suas alteracoes locais foram preservadas.'
        }
    }

    $envPath = Join-Path $root '.env'
    if (-not (Test-Path -LiteralPath $envPath)) {
        Copy-Item -LiteralPath (Join-Path $root '.env.example') -Destination $envPath
    }
    $contents = [System.IO.File]::ReadAllText($envPath)
    $match = [regex]::Match($contents, '(?m)^\s*TELEGRAM_BOT_TOKEN\s*=\s*([^\r\n]*)')
    $existingToken = $match.Groups[1].Value.Trim().Trim('"').Trim("'")
    if ($existingToken -notmatch '^\d{6,}:[A-Za-z0-9_-]{25,}$') {
        Write-Host 'Cole o token do BotFather. A digitacao ficara oculta e sera salva apenas no .env deste computador.'
        $secure = Read-Host 'Token do Telegram' -AsSecureString
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
            if ($token -notmatch '^\d{6,}:[A-Za-z0-9_-]{25,}$') { throw 'Formato de token invalido. Copie o token completo do BotFather.' }
            if ($match.Success) {
                $contents = [regex]::Replace($contents, '(?m)^\s*TELEGRAM_BOT_TOKEN\s*=[^\r\n]*', ('TELEGRAM_BOT_TOKEN=' + $token))
            } else { $contents += "`r`nTELEGRAM_BOT_TOKEN=$token`r`n" }
            [System.IO.File]::WriteAllText($envPath, $contents, (New-Object System.Text.UTF8Encoding($false)))
        } finally {
            if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
            $token = $null
            if ($secure) { $secure.Dispose() }
        }
    }
    $contents = $null
    $existingToken = $null
    $match = $null

    # Reuse our running containers; otherwise choose free host ports without stopping other apps.
    $runningBot = & docker compose ps --status running -q bot
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel consultar os containers do Nextar.' }
    $webPort = Read-NextarPort $envPath 'NEXTAR_WEB_PORT' 15173
    $apiPort = Read-NextarPort $envPath 'NEXTAR_API_PORT' 18080
    if (-not $runningBot) {
        $webPort = Find-NextarPort $webPort
        $apiPort = Find-NextarPort $apiPort
        if ($apiPort -eq $webPort) { $apiPort = Find-NextarPort ($apiPort + 1) }
    }
    Set-NextarEnvValue $envPath 'NEXTAR_WEB_PORT' ([string]$webPort)
    Set-NextarEnvValue $envPath 'NEXTAR_API_PORT' ([string]$apiPort)
    $env:NEXTAR_WEB_PORT = [string]$webPort
    $env:NEXTAR_API_PORT = [string]$apiPort
    $siteUrl = 'http://localhost:' + $webPort
    $apiUrl = 'http://localhost:' + $apiPort
    Write-Host ('Enderecos deste teste: ' + $siteUrl + ' | API: ' + $apiUrl)
    Write-Host 'Preparando os containers. A primeira inicializacao pode levar alguns minutos...'
    & docker compose up --build -d --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) {
        throw 'Falha ao iniciar. Consulte docker compose logs --tail 50 bot api e confira o Docker Desktop.'
    }
    Start-Process $siteUrl
    Write-Host ('Site iniciado: ' + $siteUrl) -ForegroundColor Green
    Write-Host 'Cadastre um produto e consulte a area Vendas e bot.'
    $status = $null
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        try { $status = Invoke-RestMethod ($apiUrl + '/api/v1/bot/status') -TimeoutSec 5 } catch { $status = $null }
        if ($status -and $status.state -eq 'connected') { break }
        if ($status -and $status.state -eq 'webhook_conflict') { break }
        Start-Sleep -Seconds 2
    }
    if ($status -and $status.state -eq 'connected') {
        Write-Host ('Telegram conectado: https://t.me/' + $status.username) -ForegroundColor Green
        Write-Host 'Abra o bot no Telegram e envie /start, depois /catalogo.'
    } else {
        Write-Host 'O site iniciou, mas o Telegram ainda nao confirmou conexao.' -ForegroundColor Yellow
        if ($status) { Write-Host $status.message }
        Write-Host 'Confira o token no .env e a area Vendas e bot. Depois execute este arquivo novamente.'
    }
    Write-Host 'A janela pode ser fechada: os containers continuam rodando enquanto o Docker estiver ativo.'
    Write-Host 'Respostas livres com IA: configure OPENAI_API_KEY no .env e execute este arquivo novamente.'
    exit 0
} catch {
    # Do not print native HTTP exceptions or secret-containing command arguments.
    Write-Host ('Falha: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
