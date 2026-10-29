@echo off
cd /d "%~dp0"
if not exist data mkdir data
node daily.mjs >> data\daily-console.log 2>&1
