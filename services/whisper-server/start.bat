@echo off
chcp 65001 > nul
set PYTHONIOENCODING=utf-8
echo [Jarvis] Starting Faster-Whisper server...
python "%~dp0server.py" %*
