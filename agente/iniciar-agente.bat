@echo off
title Gran Paolo - Agente de impressao
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agente-impressao.ps1"
pause
