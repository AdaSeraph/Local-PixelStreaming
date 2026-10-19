@echo off
rem ===========================================================================
rem  Copies this PixelStreaming2 folder (launchers + prepared offline runtime)
rem  into a packaged build, so the package can run Pixel Streaming on intranet
rem  PCs without internet / VPN. The UE plugin itself only stages
rem  get_ps_servers.bat, which downloads the servers at runtime.
rem
rem    Install-ToPackage.bat E:\pack\XHC-Shipping\Windows
rem
rem  Called by Tools\Package-Windows*.bat after archiving. Safe to re-run.
rem  Exit codes: 1 bad arguments, 2 runtime not prepared, 3 copy/verify failed.
rem ===========================================================================
setlocal DisableDelayedExpansion
if "%~1"=="" goto usage

for %%I in ("%~dp0..") do set "PS2_SRC=%%~fI"
for %%I in ("%~dp0..\..\..") do set "PS2_PROJECT=%%~nxI"
for %%I in ("%~1") do set "PS2_PKG=%%~fI"
set "PS2_DST=%PS2_PKG%\%PS2_PROJECT%\Samples\PixelStreaming2"

if not exist "%PS2_PKG%\%PS2_PROJECT%\Binaries\" (
    echo [ERROR] "%PS2_PKG%" is not a packaged build: missing %PS2_PROJECT%\Binaries
    exit /b 1
)

set "PS2_MISSING="
if not exist "%PS2_SRC%\Offline\node\node.exe" set "PS2_MISSING=1"
if not exist "%PS2_SRC%\WebServers\SignallingWebServer\dist\index.js" set "PS2_MISSING=1"
if not exist "%PS2_SRC%\WebServers\SignallingWebServer\node_modules\express\package.json" set "PS2_MISSING=1"
if defined PS2_MISSING (
    echo [ERROR] The offline Pixel Streaming runtime is not prepared in "%PS2_SRC%".
    echo         Run Offline\Prepare-OfflineRuntime.bat once on a PC with internet access.
    exit /b 2
)

echo Copying "%PS2_SRC%"
echo      to "%PS2_DST%"
rem /MIR keeps the package copy identical to the prepared runtime; Logs and run
rem state in the destination are excluded, so they are neither copied nor purged.
robocopy "%PS2_SRC%" "%PS2_DST%" /MIR /XD "%PS2_SRC%\Logs" "%PS2_SRC%\Offline\.state" /NFL /NDL /NJH /NJS /NP /R:2 /W:2
if errorlevel 8 (
    echo [ERROR] robocopy failed.
    exit /b 3
)

rem Load the copied server with the copied Node: proves the runtime is complete.
"%PS2_DST%\Offline\node\node.exe" "%PS2_DST%\WebServers\SignallingWebServer\dist\index.js" --no_config --help >nul 2>&1
if errorlevel 1 (
    echo [ERROR] The copied signalling server does not start: "%PS2_DST%"
    exit /b 3
)
echo Pixel Streaming offline runtime installed and verified.
exit /b 0

:usage
echo Usage: %~nx0 ^<packaged build folder, e.g. E:\pack\XHC-Shipping\Windows^>
exit /b 1
