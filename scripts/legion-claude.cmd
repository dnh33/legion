@echo off
rem Runs the Claude Code program that ships inside Legion (for people with no claude on PATH). First time: legion-claude.cmd, then type /login.
setlocal
"%~dp0..\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe" %*
exit /b %ERRORLEVEL%
