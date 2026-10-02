@echo off
rem Double-click to install/update Legion in %LOCALAPPDATA%\Programs\Legion. Extra args go to setup.ps1 (e.g. -InstallDir "C:\Legion").
rem Never waits for a key or a question when -Yes is passed or when input is redirected (a script, CI, a pipe).
setlocal
cd /d "%~dp0"
set "LEGION_NONINT="
for %%A in (%*) do (
  if /i "%%~A"=="-Yes" set "LEGION_NONINT=1"
  if /i "%%~A"=="/Yes" set "LEGION_NONINT=1"
)
if not defined LEGION_NONINT (
  powershell -NoProfile -Command "if ([Console]::IsInputRedirected) { exit 1 } else { exit 0 }"
  if errorlevel 1 set "LEGION_NONINT=1"
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
set "LEGION_RC=%ERRORLEVEL%"
if not defined LEGION_NONINT (
  echo.
  pause
)
exit /b %LEGION_RC%
