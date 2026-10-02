@echo off
rem Prints the MCP hookup snippets (Claude Code and Claude Desktop / Cowork) for this install. Needs no Node and no npm.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\runtime\electron\electron.exe" "%~dp0mcp-config.mjs" %*
exit /b %ERRORLEVEL%
