' Slizm Gateway Web console opener (ASCII-only for WSH compatibility).
' Opens the always-on management Web page without showing a console window.
' Closing the opened browser window never stops the background gateway or Web server.
Option Explicit

Const LOG_TAIL_CHARS = 700
Const DIALOG_TITLE = "Slizm Gateway"

Dim shell, fso, root, logDir, logPath, nodeExe, inner, exitCode, message
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = fso.BuildPath(root, "logs")
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logPath = fso.BuildPath(logDir, "open.log")

nodeExe = FindNode(shell, fso)
If Len(nodeExe) = 0 Then
  MsgBox "Slizm Gateway Web could not open: Node.js 20 or newer was not found.", vbCritical, DIALOG_TITLE
  WScript.Quit 1
End If

shell.CurrentDirectory = root
inner = Quote(nodeExe) & " " & Quote(fso.BuildPath(root, "scripts\gw.js")) & " open > " & Quote(logPath) & " 2>&1"
exitCode = shell.Run(Quote(shell.ExpandEnvironmentStrings("%ComSpec%")) & " /d /s /c " & Quote(inner), 0, True)

If exitCode <> 0 Then
  message = "Slizm Gateway Web could not open (exit code " & exitCode & ")." & vbCrLf & vbCrLf & _
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
