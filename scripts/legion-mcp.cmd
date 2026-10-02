@echo off
rem The stdio MCP proxy for Claude Desktop / Cowork, on Legion's own Node. Use this file as the "command" of an MCP server entry.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\runtime\electron\electron.exe" "%~dp0..\dist\src\bin\legion-mcp-stdio.js" %*
exit /b %ERRORLEVEL%
