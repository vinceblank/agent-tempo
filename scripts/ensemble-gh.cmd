@echo off
setlocal

rem ensemble-gh.cmd — Windows shim: re-executes scripts/ensemble-gh via Git Bash.
rem
rem Problem: `ensemble-gh` is an extensionless bash script. PowerShell resolves
rem extensionless names via PATHEXT and "runs" it as a native command — silently,
rem with exit 0 and no output (the `gh` call never fires). See issue #741.
rem
rem Fix: with this .cmd sibling present, PowerShell's PATHEXT resolution picks
rem this file instead, so `./scripts/ensemble-gh ...` from PowerShell works on
rem Windows without any change to existing invocations.
rem
rem Bash location strategy (first match wins):
rem   1. bash.exe already on PATH  (most reliable — covers all Git for Windows layouts)
rem   2. bin\bash.exe relative to git.exe on PATH
rem      (Git for Windows layout: ...\Git\cmd\git.exe  →  ...\Git\bin\bash.exe)
rem   3. Fallback: C:\Program Files\Git\bin\bash.exe
rem   4. Fail loudly — never silently no-op.

set _BASH=

rem 1. bash.exe on PATH
for /f "usebackq tokens=*" %%G in (`where bash 2^>nul`) do if not defined _BASH (
  set "_BASH=%%G"
)
if defined _BASH if exist "%_BASH%" goto :run

rem 2. bin\bash.exe relative to git.exe on PATH
for /f "usebackq tokens=*" %%G in (`where git 2^>nul`) do if not defined _BASH (
  call :set_bash_from_git "%%G"
)
if defined _BASH if exist "%_BASH%" goto :run

rem 3. Fallback: well-known Git for Windows installation path
set "_BASH=C:\Program Files\Git\bin\bash.exe"
if exist "%_BASH%" goto :run

echo ensemble-gh: cannot locate Git Bash (bash.exe). 1>&2
echo   Tried: bash on PATH, bin\bash.exe relative to git on PATH, 1>&2
echo          and C:\Program Files\Git\bin\bash.exe 1>&2
echo   Fix: install Git for Windows or ensure bash.exe is on PATH. 1>&2
exit /b 1

:set_bash_from_git
rem %~dp1 = directory of git.exe (e.g. C:\Program Files\Git\cmd\)
rem Climb one level to the Git root, then into bin\
set "_BASH=%~dp1..\bin\bash.exe"
goto :eof

:run
"%_BASH%" "%~dp0ensemble-gh" %*
exit /b %ERRORLEVEL%
