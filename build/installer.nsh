; A fresh install must never leave an older GOLD-3Po behind, wherever it was installed: stop what is
; running, run every registered uninstaller silently (settings and the tick archive live in
; %APPDATA% and are kept), then let the new version install into a clean folder.

!macro Gold3PoRemoveRegistered ROOT
  StrCpy $R1 0
  ${Do}
    EnumRegKey $R2 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R1
    ${If} $R2 == ""
      ${Break}
    ${EndIf}
    IntOp $R1 $R1 + 1
    ReadRegStr $R3 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R2" "DisplayName"
    StrCpy $R4 $R3 8
    ${If} $R4 == "GOLD-3Po"
      ReadRegStr $R5 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R2" "UninstallString"
      ReadRegStr $R6 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R2" "InstallLocation"
      ${If} $R5 != ""
        ${If} $R6 != ""
          ExecWait '$R5 /S _?=$R6'
        ${Else}
          ExecWait '$R5 /S'
        ${EndIf}
      ${EndIf}
      ${If} $R6 != ""
        StrLen $R7 $R6
        ${If} $R7 > 6
          RMDir /r "$R6"
        ${EndIf}
      ${EndIf}
      DeleteRegKey ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R2"
      StrCpy $R1 0
    ${EndIf}
  ${Loop}
!macroend

!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "GOLD-3Po Market Lab.exe"'
  Pop $R0
  nsExec::Exec 'taskkill /F /T /IM gold3po-mt5.exe'
  Pop $R0
  Sleep 800
  !insertmacro Gold3PoRemoveRegistered HKCU
  !insertmacro Gold3PoRemoveRegistered HKLM
  SetRegView 32
  !insertmacro Gold3PoRemoveRegistered HKLM
  SetRegView 64
  !insertmacro Gold3PoRemoveRegistered HKLM
  SetRegView lastused
!macroend
