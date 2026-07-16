@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 exit /b %errorlevel%
)
start "Identity Audit API" cmd /k "cd /d ""%~dp0"" && npm.cmd run dev:api"
start "Identity Audit Dashboard" cmd /k "cd /d ""%~dp0"" && npm.cmd run dev:web"
echo Dashboard: http://127.0.0.1:3000
echo API:       http://127.0.0.1:4318
