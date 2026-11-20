@echo off
setlocal
set "dashboard_python=%~dp0.venv\Scripts\python.exe"
if exist "%dashboard_python%" goto run
set "dashboard_python=%USERPROFILE%\OneDrive - hertshtengroup.com\Desktop\inter-market\.venv\Scripts\python.exe"
if exist "%dashboard_python%" goto run
set "dashboard_python=%LocalAppData%\Programs\Python\Python313\python.exe"
if exist "%dashboard_python%" goto run
where.exe py >nul 2>&1
if errorlevel 1 goto python_path
py -3 "%~dp0dashboard.py" %*
goto done

:python_path
set "dashboard_python=python"

:run
"%dashboard_python%" "%~dp0dashboard.py" %*

:done
if errorlevel 1 pause
