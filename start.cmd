@echo off
REM Starter en lokal webserver for SSBMS.
REM Service worker og GPS krever http://localhost - aa aapne index.html
REM direkte som fil virker ikke.
cd /d "%~dp0"
where npx >nul 2>nul
if %errorlevel%==0 (
  echo Starter paa http://localhost:5173
  npx --yes serve -l 5173 .
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  echo Starter paa http://localhost:5173
  python -m http.server 5173
  goto :eof
)
echo Fant verken npx eller python. Installer Node.js eller Python.
pause
