' Launch PAC without showing a console window.
' The desktop shortcut "PAC" points here (wscript.exe launch.vbs).
' ASCII only: Windows reads .vbs in the ANSI code page.
'
' All the work (rebuild when sources changed, start Electron) is in launch.ps1.
' Run(..., 0, False) = window hidden, do not wait.
Set sh = CreateObject("WScript.Shell")
root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
sh.CurrentDirectory = root
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\launch.ps1""", 0, False
