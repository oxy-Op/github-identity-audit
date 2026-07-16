@echo off
setlocal
cd /d "%~dp0"
call npm.cmd ci
if errorlevel 1 exit /b %errorlevel%
call npm.cmd run verify
exit /b %errorlevel%
