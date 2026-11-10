@echo off
rem ===========================================================================
rem  DSH rescue console - safe to double-click when DSH cannot start.
rem
rem  This file is deliberately PURE ASCII. cmd.exe parses batch files in the
rem  console codepage, so any non-ASCII byte in here can be misread even after
rem  "chcp 65001"; the menu itself (Chinese text, prompts) is rendered by Node.
rem
rem  It locates a Node runtime by itself because a rescue tool that needs PATH
rem  would fail on exactly the machines it exists for.
rem ===========================================================================
chcp 65001 >nul
setlocal enabledelayedexpansion
title DSH rescue console

set "SCRIPT=%~dp0dsh-rescue.mjs"
set "NODE="

rem DSH ships its own runtime; that copy is the one that certainly exists.
for %%R in (
  "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  "%LOCALAPPDATA%\Programs\@deepseek-ai\dsh-desktop\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  "D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  "C:\Program Files\nodejs\node.exe"
  "C:\Program Files (x86)\nodejs\node.exe"
) do (
  if not defined NODE if exist %%R set "NODE=%%~R"
)
if not defined NODE (
  for %%P in (node.exe) do set "NODE=%%~$PATH:P"
)

if not defined NODE (
  echo.
  echo   [x] node.exe not found. The rescue console cannot run.
  echo       Check that DSH is installed in its default location,
  echo       or install Node.js and try again.
  echo.
  pause
  exit /b 2
)

rem Everything else - the menu, the prompts, all user-visible text - lives in Node.
"%NODE%" "%SCRIPT%" menu
set "CODE=%ERRORLEVEL%"

rem Keep the window open when this was started by double-click, so the
rem diagnosis stays readable. A non-zero exit still shows its output first.
if "%~1"=="" pause
endlocal & exit /b %CODE%
