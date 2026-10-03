@echo off
rem Runs a script or -e code on Legion's own Node (the Electron runtime in node mode). No system Node needed.
rem Example: scripts\legion-node.cmd dist\src\bin\legion-core.js
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\runtime\electron\electron.exe" %*
exit /b %ERRORLEVEL%
