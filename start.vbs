' Slizm Gateway launcher. ASCII-only on purpose: Windows Script Host reads this file with the
' system code page, so every message lives in logs/launcher.log or scripts/test-launcher.mjs.
' Double-clicking starts the gateway and opens the management page as a browser app window.
' wscript.exe hosts this file, which is why no console window (the old black box) appears.
Option Explicit

Const LOG_TAIL_CHARS = 700
Const DIALOG_TITLE = "Slizm Gateway"

Dim shell, fso, root, logDir, logPath, nodeExe, inner, exitCode, message
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = fso.BuildPath(root, "logs")
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logPath = fso.BuildPath(logDir, "launcher.log")

nodeExe = FindNode(shell, fso)
If Len(nodeExe) = 0 Then
  MsgBox "Slizm Gateway could not start: Node.js 20 or newer was not found." & vbCrLf & vbCrLf & _
         "Install it from https://nodejs.org/ and double-click start.vbs again.", _
         vbCritical, DIALOG_TITLE
  WScript.Quit 1
End If

' Run "gw.js up" hidden and wait for it: the gateway, the management Web server and the browser
' window are all detached children, so nothing here stays alive after this script exits.
shell.CurrentDirectory = root
inner = Quote(nodeExe) & " " & Quote(fso.BuildPath(root, "scripts\gw.js")) & " up > " & Quote(logPath) & " 2>&1"
exitCode = shell.Run(Quote(shell.ExpandEnvironmentStrings("%ComSpec%")) & " /d /s /c " & Quote(inner), 0, True)

If exitCode <> 0 Then
  message = "Slizm Gateway could not start (exit code " & exitCode & ")." & vbCrLf & vbCrLf & _
            "Log: " & logPath & vbCrLf & vbCrLf & ReadLogTail(logPath, LOG_TAIL_CHARS)
  MsgBox message, vbCritical, DIALOG_TITLE
  WScript.Quit 1
End If

WScript.Quit 0

Function Quote(value)
  Quote = """" & value & """"
End Function

Function HasNode(shell, exe)
  Dim code
  HasNode = False
  On Error Resume Next
  code = shell.Run(Quote(shell.ExpandEnvironmentStrings("%ComSpec%")) & " /d /s /c " & _
                   Quote(Quote(exe) & " --version >nul 2>&1"), 0, True)
  If Err.Number = 0 Then
    If code = 0 Then HasNode = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

' node.exe from PATH first, then the usual install locations (including nvm-windows).
Function FindNode(shell, fso)
  Dim bases, relatives, i, base, candidate
  FindNode = ""
  If HasNode(shell, "node.exe") Then
    FindNode = "node.exe"
    Exit Function
  End If
  bases = Array("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "NVM_HOME", "NVM_SYMLINK")
  relatives = Array("nodejs\node.exe", "nodejs\node.exe", "Programs\nodejs\node.exe", "node.exe", "node.exe")
  For i = 0 To UBound(bases)
    base = shell.ExpandEnvironmentStrings("%" & bases(i) & "%")
    If Len(base) > 0 Then
      If InStr(base, "%") = 0 Then
        candidate = fso.BuildPath(base, relatives(i))
        If fso.FileExists(candidate) Then
          If HasNode(shell, candidate) Then
            FindNode = candidate
            Exit Function
          End If
        End If
      End If
    End If
  Next
End Function

' gw.js writes UTF-8, so read the tail through ADODB.Stream instead of the ANSI FileSystemObject.
Function ReadLogTail(path, maxChars)
  Dim stream, text
  ReadLogTail = ""
  On Error Resume Next
  Set stream = CreateObject("ADODB.Stream")
  stream.Type = 2
  stream.Charset = "utf-8"
  stream.Open
  stream.LoadFromFile path
  text = stream.ReadText(-1)
  stream.Close
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  On Error GoTo 0
  If Len(text) > maxChars Then text = Mid(text, Len(text) - maxChars + 1)
  ReadLogTail = text
End Function
