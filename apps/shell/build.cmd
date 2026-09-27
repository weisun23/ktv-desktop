@echo off
rem Build KTV Desktop for Windows.
rem   build.cmd         -> NSIS installer + portable exe
rem   build.cmd --dir   -> unpacked dir only (faster, for debugging)
setlocal
cd /d "%~dp0"

rem Use China mirrors to avoid download timeouts
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_CACHE=%~dp0..\..\.eb-cache

echo [1/2] building frontend...
call npm --prefix ..\web run build || exit /b 1

echo [2/2] packaging...
if "%~1"=="--dir" (
  call node_modules\.bin\electron-builder.cmd --win --dir
) else (
  call node_modules\.bin\electron-builder.cmd --win
)
