@echo off
rem Start SonOfSatoshi Minter and open it in your browser (Windows). Needs Python 3 from python.org.
cd /d "%~dp0"
start "SonOfSatoshi Minter" /min python server.py
timeout /t 2 >nul
start http://127.0.0.1:8130
