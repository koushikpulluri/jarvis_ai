@echo off
chcp 65001 > nul
set PYTHONIOENCODING=utf-8
echo [Jarvis] Starting Piper TTS server...
python "%~dp0server.py" %*
