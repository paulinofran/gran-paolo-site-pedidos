@echo off
title Gran Paolo - Teste das impressoras
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agente-impressao.ps1" -Teste
