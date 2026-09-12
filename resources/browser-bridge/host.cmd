@echo off
setlocal
REM Packaged Native Messaging host launcher (EXT-B1).
REM Layout: <app>/Verstak.exe  and  <app>/resources/browser-bridge/{host.cmd,host.mjs}
REM Prefer absolute path rewrite by installNativeHost at first app start.
set "HOST_DIR=%~dp0"
set "HOST_JS=%HOST_DIR%host.mjs"
set "ELECTRON_EXE=%HOST_DIR%..\..\Verstak.exe"
if exist "%ELECTRON_EXE%" (
  set ELECTRON_RUN_AS_NODE=1
  "%ELECTRON_EXE%" "%HOST_JS%"
  exit /b %ERRORLEVEL%
)
echo Verstak native host: Verstak.exe not found at "%ELECTRON_EXE%" 1>&2
exit /b 1
