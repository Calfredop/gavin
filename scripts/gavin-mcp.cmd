@echo off
rem Resolve and exec the gavin-mcp binary for whatever machine this
rem checkout is sitting on -- the Windows half of `scripts/gavin-mcp`,
rem which carries the full reasoning. Keep the search order in step.
rem
rem `.mcp.json` and `.cursor/mcp.json` name `scripts/gavin-mcp` on both
rem platforms; Windows resolves that through PATHEXT to this file.
rem
rem Every statement here is a SINGLE line on purpose. `.gitattributes`
rem pins the whole tree to LF on disk, and cmd.exe mis-parses multi-line
rem parenthesised blocks and goto labels in an LF-only batch file.
rem
rem Nothing may reach stdout but the binary's own JSON-RPC -- a stray echo
rem corrupts the stream and the server dies as a parse error.

setlocal

set "BIN="
if defined GAVIN_MCP if exist "%GAVIN_MCP%" set "BIN=%GAVIN_MCP%"
if not defined BIN if exist "%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe" set "BIN=%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe"
if not defined BIN if exist "%~dp0..\target\release\gavin-mcp.exe" set "BIN=%~dp0..\target\release\gavin-mcp.exe"
if not defined BIN if exist "%~dp0..\target\debug\gavin-mcp.exe" set "BIN=%~dp0..\target\debug\gavin-mcp.exe"
if not defined BIN for %%I in (gavin-mcp.exe) do if not "%%~$PATH:I"=="" set "BIN=%%~$PATH:I"

if not defined BIN echo gavin-mcp: no binary found. Tried GAVIN_MCP, %LOCALAPPDATA%\Programs\Gavin, this checkout's target\release and target\debug, then PATH. 1>&2
if not defined BIN echo Install Gavin, run `cargo build -p gavin-mcp`, or set GAVIN_MCP. 1>&2
if not defined BIN exit /b 1

"%BIN%" %*
