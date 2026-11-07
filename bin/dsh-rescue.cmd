@echo off
rem dsh-rescue launcher for Windows.
rem
rem DSH ships its own Node runtime and this machine has none on PATH, so a rescue tool started
rem from Explorer would fail before it could help. This probes the known runtime locations and
rem falls back to PATH, then hands every argument through unchanged.

setlocal enabledelayedexpansion
set "SCRIPT=%~dp0dsh-rescue.mjs"
set "NODE="

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
  echo   找不到 node.exe，无法运行救援工具。
  echo   请用 --node 之外的方式指定，或安装 Node.js 后重试。
  echo.
  echo   已尝试的位置：
  echo     %USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
  echo     D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
  echo.
  pause
  exit /b 2
)

"%NODE%" "%SCRIPT%" %*

rem Keep the window open when started by double-click, so the diagnosis stays readable.
if "%~1"=="" (
  echo.
  pause
)
endlocal
