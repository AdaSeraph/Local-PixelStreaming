@echo off
rem ===========================================================================
rem  VirtualCity PixelStreaming2 - self check: runtime files, network adapters,
rem  port conflicts, UE program location. Send a screenshot of the output when
rem  asking for help.
rem ===========================================================================
setlocal DisableDelayedExpansion
set "PS2_NODE=%~dp0Offline\node\node.exe"
if not exist "%PS2_NODE%" (
    echo [ERROR] Offline runtime not found: "%PS2_NODE%"
    echo Run Offline\Prepare-OfflineRuntime.bat once on a PC with internet access,
    echo then copy the whole PixelStreaming2 folder to this PC again.
    pause
    exit /b 1
)
"%PS2_NODE%" "%~dp0Offline\ps2-offline.js" check %*
set "PS2_RC=%ERRORLEVEL%"
rem Keep the window open when started by double-click.
echo "%CMDCMDLINE%" | findstr /i /c:"%~nx0" >nul && pause
exit /b %PS2_RC%
