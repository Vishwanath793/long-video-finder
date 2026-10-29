@echo off
rem One-time setup of the members-only helper (Python 3.11+ needed: winget install Python.Python.3.12)
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  py -3 -m venv .venv || python -m venv .venv || (echo Python 3 not found. Install it with: winget install Python.Python.3.12 & pause & exit /b 1)
)
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
echo.
echo Done. Optional speech-to-text for videos without captions:
echo   .venv\Scripts\pip install -r requirements-whisper.txt
pause
