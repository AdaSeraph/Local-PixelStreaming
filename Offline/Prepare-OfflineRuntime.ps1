#Requires -Version 5.1
<#
.SYNOPSIS
  生成 PixelStreaming2 信令服务器的"离线运行时": 便携 Node + 已编译的信令服务器 + 运行期依赖。

.DESCRIPTION
  只需要在一台能上网(或能访问国内镜像)的开发机上运行一次。完成后整个
  Samples/PixelStreaming2 目录(打包后是 <包>/VirtualCity/Samples/PixelStreaming2)
  可以直接复制到任何内网电脑: 不装 Node、不联网、不开 VPN、不查公网 IP。

  步骤:
    1. 下载便携 Node(版本取 WebServers/NODE_VERSION)并校验 SHA256
    2. 在临时目录安装依赖, 编译 Common / Signalling / SignallingWebServer
    3. 用 npm 生成只含运行期依赖、没有符号链接/目录联接的 node_modules
       (npm workspaces 默认用目录联接, 联接里存的是绝对路径, 拷到别的电脑就断)
    4. 替换进 WebServers/SignallingWebServer 的 dist 和 node_modules
    5. 去掉自带网页里的 Google 字体外链(内网里会卡住网页加载)
    6. 可选: 准备 coturn 便携版, 供"本机 TURN"模式使用
  全部成功之后才替换现有运行时, 中途失败不会破坏已有的可用版本。

.PARAMETER Mirror
  official = nodejs.org + registry.npmjs.org(默认)
  cn       = npmmirror.com 国内镜像(不开 VPN 时用)
.PARAMETER NodeZip
  已下载好的 node-<版本>-win-x64.zip。指定后不再下载 Node。
.PARAMETER TurnZip
  已下载好的 Epic coturn Windows 包(turnserver.zip)。
.PARAMETER NoTurn
  不准备 coturn。PixelStreaming.ini 里的 [Turn] Mode=local 将不可用。
.PARAMETER KeepTemp
  保留临时构建目录, 排查问题时用。
#>
[CmdletBinding()]
param(
    [ValidateSet('official', 'cn')][string]$Mirror = 'official',
    [string]$NodeZip,
    [string]$TurnZip,
    [switch]$NoTurn,
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # PS 5.1 的进度条会让 Invoke-WebRequest 慢几十倍
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$TurnUrl = 'https://github.com/EpicGamesExt/PixelStreamingInfrastructure/releases/download/v4.5.2-coturn-windows/turnserver.zip'

$OfflineDir = $PSScriptRoot
$Root = Split-Path -Parent $OfflineDir
$Web = Join-Path $Root 'WebServers'
$Sws = Join-Path $Web 'SignallingWebServer'
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'   # 系统自带 bsdtar 能解 zip; Git 的 GNU tar 不能
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { throw $Text }

# PS 5.1 在 stderr 被重定向时会把原生命令的 stderr 行包装成错误记录, 遇到
# $ErrorActionPreference=Stop 直接中断(npm 的 "npm warn ..." 就走 stderr)。
# 所以原生命令一律只看退出码。
function Invoke-Native([string]$WorkDir, [string]$Exe, [string[]]$Arguments) {
    Push-Location $WorkDir
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
        Pop-Location
    }
    if ($code -ne 0) { Fail "命令失败(退出码 $code): $Exe $($Arguments -join ' ')" }
}

# robocopy 退出码 0-7 都是成功, 8 及以上才是失败。它能处理超过 260 字符的深路径,
# 这对 node_modules 很重要(PS 5.1 的 Copy-Item / Remove-Item 处理不了)。
function Invoke-Robocopy([string]$From, [string]$To, [string[]]$Extra) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & robocopy.exe $From $To @Extra /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
    if ($code -ge 8) { Fail "robocopy 失败(退出码 $code): $From -> $To" }
}

function Get-FileText([string]$Path) { [IO.File]::ReadAllText($Path) }
function Set-FileText([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, $Utf8NoBom) }

function Get-InstalledVersion([string[]]$SearchRoots, [string]$Package) {
    foreach ($r in $SearchRoots) {
        $pj = Join-Path $r ("node_modules\" + ($Package -replace '/', '\') + "\package.json")
        if (Test-Path $pj) { return (Get-FileText $pj | ConvertFrom-Json).version }
    }
    Fail "构建目录里找不到依赖 $Package"
}

function Invoke-Download([string]$Url, [string]$OutFile) {
    Write-Host "    下载 $Url"
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

# ---------------------------------------------------------------------------
Write-Step '检查目录'
foreach ($p in @("$Web\NODE_VERSION", "$Web\package-lock.json", "$Web\Common\package.json",
                 "$Web\Signalling\package.json", "$Sws\package.json", "$Sws\www\player.html")) {
    if (-not (Test-Path $p)) {
        Fail "缺少 $p`n先在 WebServers 目录运行一次 get_ps_servers.bat 取回 Epic 的像素流服务器源码。"
    }
}
if (-not (Test-Path $Tar)) { Fail "找不到 $Tar (需要 Windows 10 1803 或更新版本)" }

$NodeVersion = (Get-FileText "$Web\NODE_VERSION").Trim()
if ($NodeVersion -notmatch '^v\d+\.\d+\.\d+$') { Fail "NODE_VERSION 内容不对: '$NodeVersion'" }
$NodeName = "node-$NodeVersion-win-x64"
$PsInfraVersion = if (Test-Path "$Web\DOWNLOAD_VERSION") { (Get-FileText "$Web\DOWNLOAD_VERSION").Trim() } else { 'unknown' }

if ($Mirror -eq 'cn') {
    $NodeBase = "https://npmmirror.com/mirrors/node/$NodeVersion"
    $env:npm_config_registry = 'https://registry.npmmirror.com/'
} else {
    $NodeBase = "https://nodejs.org/dist/$NodeVersion"
    $env:npm_config_registry = 'https://registry.npmjs.org/'
}
$env:npm_config_update_notifier = 'false'
$env:npm_config_fund = 'false'
$env:npm_config_audit = 'false'

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('ps2-offline-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
Write-Host "    PS 基础设施版本: $PsInfraVersion"
Write-Host "    Node 版本     : $NodeVersion"
Write-Host "    npm 源        : $env:npm_config_registry"
Write-Host "    临时目录      : $Tmp"

try {
    # -----------------------------------------------------------------------
    Write-Step "准备便携 Node $NodeVersion"
    $dl = Join-Path $Tmp 'dl'
    New-Item -ItemType Directory -Force -Path $dl | Out-Null
    if ($NodeZip) {
        if (-not (Test-Path $NodeZip)) { Fail "找不到 -NodeZip 指定的文件: $NodeZip" }
        $zip = (Resolve-Path $NodeZip).Path
    } else {
        $zip = Join-Path $dl "$NodeName.zip"
        Invoke-Download "$NodeBase/$NodeName.zip" $zip
    }
    $sums = Join-Path $dl 'SHASUMS256.txt'
    try {
        Invoke-Download "$NodeBase/SHASUMS256.txt" $sums
        $line = Select-String -Path $sums -SimpleMatch "$NodeName.zip" | Select-Object -First 1
        if (-not $line) { Fail "SHASUMS256.txt 里没有 $NodeName.zip" }
        $expected = ($line.Line -split '\s+')[0].ToLower()
        $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
        if ($expected -ne $actual) { Fail "Node 压缩包 SHA256 不匹配`n期望 $expected`n实际 $actual" }
        Write-Host "    SHA256 校验通过: $actual"
    } catch {
        if (-not $NodeZip) { throw }
        Write-Warning "拿不到官方校验和, 跳过校验(使用本地 -NodeZip): $($_.Exception.Message)"
    }
    Invoke-Native $Tmp $Tar @('-xf', $zip, '-C', $Tmp)
    $NodeDir = Join-Path $Tmp $NodeName
    $NodeExe = Join-Path $NodeDir 'node.exe'
    $NpmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path $NodeExe) -or -not (Test-Path $NpmCli)) { Fail "Node 压缩包内容不完整: $zip" }

    function Invoke-Npm([string]$Dir, [string[]]$NpmArgs) { Invoke-Native $Dir $NodeExe (@($NpmCli) + $NpmArgs) }

    # -----------------------------------------------------------------------
    Write-Step '在临时目录安装依赖并编译信令服务器'
    $Ws = Join-Path $Tmp 'ws'
    Invoke-Robocopy "$Web\Common" "$Ws\Common" @('/E', '/XD', 'node_modules', 'dist', 'docs')
    Invoke-Robocopy "$Web\Signalling" "$Ws\Signalling" @('/E', '/XD', 'node_modules', 'dist', 'docs')
    Invoke-Robocopy $Sws "$Ws\SignallingWebServer" @('/E', '/XD', 'node_modules', 'dist', 'www', 'logs', 'platform_scripts')
    Copy-Item "$Web\package-lock.json" "$Ws\package-lock.json"

    # 只保留信令服务器用到的三个工作区。前端(已预编译在 www 里)、SFU(mediasoup 安装时
    # 还要下载/编译原生组件)这些都不需要。名字保持和原来一致, 版本就沿用 Epic 的锁文件。
    $rootPkg = Get-FileText "$Web\package.json" | ConvertFrom-Json
    $typesNode = $rootPkg.devDependencies.'@types/node'
    if (-not $typesNode) { $typesNode = '^22.14.0' }
    $wsPkg = [ordered]@{
        name            = $rootPkg.name
        private         = $true
        workspaces      = @('Common', 'Signalling', 'SignallingWebServer')
        devDependencies = [ordered]@{ '@types/node' = $typesNode }
    }
    Set-FileText "$Ws\package.json" ($wsPkg | ConvertTo-Json -Depth 5)

    # --ignore-scripts: 用不到任何安装脚本(比如 @protobuf-ts 会去下 protoc)。
    Invoke-Npm $Ws @('install', '--ignore-scripts', '--no-audit', '--no-fund')
    Invoke-Npm $Ws @('run', 'build:cjs', '--workspace=Common')
    Invoke-Npm $Ws @('run', 'build:cjs', '--workspace=Signalling')
    Invoke-Npm $Ws @('run', 'build', '--workspace=SignallingWebServer')
    if (-not (Test-Path "$Ws\SignallingWebServer\dist\index.js")) { Fail '编译后没有 SignallingWebServer\dist\index.js' }

    # -----------------------------------------------------------------------
    Write-Step '生成只含运行期依赖的 node_modules'
    # Common / Signalling 的 .gitignore 忽略了 dist, 没有 .npmignore 时 npm pack 会沿用它,
    # 包里就没有编译产物。这里补一个 .npmignore 让 dist 进包。
    $npmIgnore = "src/`r`nnode_modules/`r`ndocs/`r`n*.tsbuildinfo`r`n"
    Set-FileText "$Ws\Common\.npmignore" $npmIgnore
    Set-FileText "$Ws\Signalling\.npmignore" $npmIgnore
    $Pkgs = Join-Path $Tmp 'pkgs'
    New-Item -ItemType Directory -Force -Path $Pkgs | Out-Null
    Invoke-Npm $Ws @('pack', '--workspace=Common', '--workspace=Signalling', '--pack-destination', $Pkgs)
    $commonTgz = Get-ChildItem $Pkgs -Filter 'epicgames-ps-lib-pixelstreamingcommon-*.tgz' | Select-Object -First 1
    $signallingTgz = Get-ChildItem $Pkgs -Filter 'epicgames-ps-lib-pixelstreamingsignalling-*.tgz' | Select-Object -First 1
    if (-not $commonTgz -or -not $signallingTgz) { Fail "npm pack 没有生成预期的 tgz: $Pkgs" }

    # 运行期依赖按构建时锁文件解析出的版本精确钉住, 行为与编译时一致。
    $search = @($Ws, "$Ws\SignallingWebServer", "$Ws\Signalling", "$Ws\Common")
    $deps = [ordered]@{
        '@epicgames-ps/lib-pixelstreamingcommon-ue5.5'     = "file:../pkgs/$($commonTgz.Name)"
        '@epicgames-ps/lib-pixelstreamingsignalling-ue5.5' = "file:../pkgs/$($signallingTgz.Name)"
    }
    foreach ($pj in @("$Ws\SignallingWebServer\package.json", "$Ws\Signalling\package.json", "$Ws\Common\package.json")) {
        $p = Get-FileText $pj | ConvertFrom-Json
        if (-not $p.dependencies) { continue }
        foreach ($name in $p.dependencies.PSObject.Properties.Name) {
            if ($name -like '@epicgames-ps/*' -or $name -like '@types/*' -or $deps.Contains($name)) { continue }
            $deps[$name] = Get-InstalledVersion $search $name
        }
    }
    $Rt = Join-Path $Tmp 'runtime'
    New-Item -ItemType Directory -Force -Path $Rt | Out-Null
    $rtPkg = [ordered]@{ name = 'ps2-signalling-runtime'; private = $true; dependencies = $deps }
    Set-FileText "$Rt\package.json" ($rtPkg | ConvertTo-Json -Depth 5)
    Invoke-Npm $Rt @('install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--install-links')

    $reparse = @(Get-ChildItem "$Rt\node_modules" -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)
    if ($reparse.Count -gt 0) { Fail "node_modules 里仍有符号链接/目录联接: $($reparse[0].FullName)" }
    $probe = "for (const m of ['@epicgames-ps/lib-pixelstreamingsignalling-ue5.5','@epicgames-ps/lib-pixelstreamingcommon-ue5.5','express','express-openapi','commander','jsonc']) require(m); console.log('    runtime dependencies load OK');"
    Invoke-Native $Rt $NodeExe @('-e', $probe)

    # -----------------------------------------------------------------------
    if (-not $NoTurn) {
        Write-Step '准备 coturn(本机 TURN 模式用)'
        try {
            if ($TurnZip) {
                if (-not (Test-Path $TurnZip)) { Fail "找不到 -TurnZip 指定的文件: $TurnZip" }
                $tz = (Resolve-Path $TurnZip).Path
            } else {
                $tz = Join-Path $dl 'turnserver.zip'
                Invoke-Download $TurnUrl $tz
            }
            $TurnDir = Join-Path $Tmp 'coturn'
            New-Item -ItemType Directory -Force -Path $TurnDir | Out-Null
            Invoke-Native $Tmp $Tar @('-xf', $tz, '-C', $TurnDir)
            if (-not (Test-Path "$TurnDir\turnserver.exe")) { Fail 'turnserver.zip 里没有 turnserver.exe' }
        } catch {
            $TurnDir = $null
            Write-Warning "coturn 没准备好, 本机 TURN 模式不可用(不影响默认的内网直连): $($_.Exception.Message)"
            Write-Warning "可以另外下载 $TurnUrl 后用 -TurnZip 指定。"
        }
    }

    # -----------------------------------------------------------------------
    Write-Step '替换运行时'
    Invoke-Robocopy "$Rt\node_modules" "$Sws\node_modules" @('/MIR')
    Invoke-Robocopy "$Ws\SignallingWebServer\dist" "$Sws\dist" @('/MIR')
    New-Item -ItemType Directory -Force -Path "$OfflineDir\node" | Out-Null
    Copy-Item $NodeExe "$OfflineDir\node\node.exe" -Force
    Copy-Item (Join-Path $NodeDir 'LICENSE') "$OfflineDir\node\LICENSE" -Force
    if ($TurnDir) { Invoke-Robocopy $TurnDir "$OfflineDir\coturn" @('/MIR') }
    Write-Host "    node          -> $OfflineDir\node\node.exe"
    Write-Host "    dist          -> $Sws\dist"
    Write-Host "    node_modules  -> $Sws\node_modules"
    if ($TurnDir) { Write-Host "    coturn        -> $OfflineDir\coturn" }

    # -----------------------------------------------------------------------
    Write-Step '去掉网页里的 Google 字体外链'
    # 这些 <link> 在 <head> 里会阻塞渲染: 内网访问不了 Google 时, 播放页要等到连接超时才出来。
    $htmlFiles = @(Get-ChildItem "$Sws\www" -Filter '*.html' -File) +
                 @(Get-ChildItem "$Web\Frontend\implementations\typescript\src" -Filter '*.html' -File -ErrorAction SilentlyContinue)
    foreach ($f in $htmlFiles) {
        $text = Get-FileText $f.FullName
        $new = [regex]::Replace($text, '[ \t]*<link[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>[ \t]*(\r?\n)?', '')
        $new = [regex]::Replace($new, "font-family:(\s*)'?Montserrat'?(\s*);", "font-family:`$1'Montserrat', Arial, sans-serif`$2;")
        if ($new -ne $text) {
            Set-FileText $f.FullName $new
            Write-Host "    已处理 $($f.FullName.Substring($Root.Length + 1))"
        }
    }
    # 首页: 带上悬停鼠标等默认参数跳到 player.html(Epic 默认的锁定鼠标点不中 UE 的 UI 按钮)。
    # 启动器每次启动也会同步一次, 这里先放好, 打包出去的目录不依赖首次启动。
    Copy-Item "$OfflineDir\web\index.html" "$Sws\www\index.html" -Force
    Write-Host '    已放入 WebServers\SignallingWebServer\www\index.html'

    # -----------------------------------------------------------------------
    Write-Step '写入运行时信息并自检'
    $info = [ordered]@{
        preparedAt       = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        psInfraVersion   = $PsInfraVersion
        nodeVersion      = $NodeVersion
        wilburVersion    = (Get-FileText "$Sws\package.json" | ConvertFrom-Json).version
        signallingLib    = (Get-FileText "$Ws\Signalling\package.json" | ConvertFrom-Json).version
        commonLib        = (Get-FileText "$Ws\Common\package.json" | ConvertFrom-Json).version
        turnserver       = [bool](Test-Path "$OfflineDir\coturn\turnserver.exe")
        npmRegistry      = $env:npm_config_registry
    }
    Set-FileText "$OfflineDir\runtime-info.json" ($info | ConvertTo-Json -Depth 3)
    Invoke-Native $Sws "$OfflineDir\node\node.exe" @("$Sws\dist\index.js", '--no_config', '--help') | Out-Null
    Write-Host '    信令服务器可以启动(--help 通过)'

    Write-Host ''
    Write-Host '完成。现在可以:' -ForegroundColor Green
    Write-Host "  - 在本机双击 $Root\Start-PixelStreaming.bat 验证"
    Write-Host '  - 重新打包(Tools\Package-Windows*.bat 会把这个目录一并放进包里)'
    Write-Host '  - 或直接把整个 PixelStreaming2 目录拷到内网电脑'
} finally {
    if ($KeepTemp) {
        Write-Host "临时目录保留在 $Tmp"
    } else {
        # 临时目录里的 node_modules 路径很深, 用 robocopy 镜像一个空目录来清空
        $empty = Join-Path ([IO.Path]::GetTempPath()) ('ps2-empty-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $empty | Out-Null
        try { Invoke-Robocopy $empty $Tmp @('/MIR') } catch { }
        Remove-Item -Recurse -Force $Tmp, $empty -ErrorAction SilentlyContinue
    }
}
