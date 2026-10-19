@echo off
rem ===========================================================================
rem  VirtualCity PixelStreaming2 - stop the signalling server, the optional TURN
rem  server and the UE program (needed when UE runs without a window).
rem ===========================================================================
setlocal DisableDelayedExpansion
set "PS2_NODE=%~dp0Offline\node\node.exe"
if not exist "%PS2_NODE%" (
    echo [ERROR] Offline runtime not found: "%PS2_NODE%"
    pause
    exit /b 1
)
"%PS2_NODE%" "%~dp0Offline\ps2-offline.js" stop %*
set "PS2_RC=%ERRORLEVEL%"
rem Keep the window open when started by double-click.
echo "%CMDCMDLINE%" | findstr /i /c:"%~nx0" >nul && pause
exit /b %PS2_RC%
