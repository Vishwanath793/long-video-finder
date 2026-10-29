@echo off
cd /d "%~dp0"
rem Opens the browser itself, at port 3000 or the next free port if 3000 is taken.
node server.mjs --open
