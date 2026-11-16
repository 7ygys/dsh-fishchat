@echo off
setlocal

rem Repair the dsh-rooms junction.
rem
rem Why this exists:
rem   dsh-rooms is linked into the DSH profile via `link:` in package.json.
rem   `pnpm install` sometimes treats `link:E:/...` as a RELATIVE path and
rem   builds `...\profiles\desktop\E:\...`, which does not exist. DSH then
rem   cannot find the package and the whole group feature disappears
rem   (this happened on 2026-11-16).
rem
rem Usage: double-click this file, or run fix-link.cmd from a terminal.
rem Safe to re-run: rmdir only removes the junction, never the files.

set "TARGET=%~dp0"
if "%TARGET:~-1%"=="\" set "TARGET=%TARGET:~0,-1%"
set "PROFILE=%USERPROFILE%\.dsh\profiles\desktop"
set "LINK=%PROFILE%\node_modules\dsh-rooms"

if not exist "%TARGET%\index.js" (
  echo [x] index.js not found. Put this script inside the plugin folder.
  pause
  exit /b 1
)

if exist "%LINK%" (
  rmdir "%LINK%" 2>nul
)

mklink /J "%LINK%" "%TARGET%" >nul 2>&1
if errorlevel 1 (
  echo [x] Could not create the junction. Close DSH and try again.
  pause
  exit /b 1
)

echo [ok] Junction repaired
echo      %LINK%
echo   -^> %TARGET%
echo.
echo Restart DSH for the plugin to load again.
pause
