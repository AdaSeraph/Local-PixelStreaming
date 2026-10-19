@echo off
rem ===========================================================================
rem  VirtualCity PixelStreaming2 - one-click start for intranet PCs.
rem  Starts the signalling server with the bundled portable Node (no internet,
rem  no VPN, no public IP lookup), then the packaged UE program exactly as it
rem  normally runs (visible window); the web stream mirrors the local screen.
rem  Settings: PixelStreaming.ini    Help: README-Intranet.txt
rem  Closing this window stops Pixel Streaming and the UE program.
rem ===========================================================================
setlocal DisableDelayedExpansion
set "PS2_NODE=%~dp0Offline\node\node.exe"
if not exist "%PS2_NODE%" goto no_runtime
"%PS2_NODE%" "%~dp0Offline\ps2-offline.js" start %*
set "PS2_RC=%ERRORLEVEL%"
if not "%PS2_RC%"=="0" pause
exit /b %PS2_RC%

:no_runtime
echo [ERROR] Offline runtime not found: "%PS2_NODE%"
echo Run Offline\Prepare-OfflineRuntime.bat once on a PC with internet access,
echo then copy the whole PixelStreaming2 folder to this PC again.
pause
exit /b 1
