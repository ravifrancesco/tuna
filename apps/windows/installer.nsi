; The Tuna for Windows installer (made by build.sh with NSIS).
; Installs for the current person only (no administrator rights needed) into
; %LOCALAPPDATA%\Programs\Tuna, with Start menu and desktop shortcuts.
; Saved as UTF-8 with a BOM, so makensis reads the Italian text right on any system.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

Name "Tuna"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Tuna"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Tuna ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Tuna"
VIAddVersionKey "FileDescription" "Tuna installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Tuna"
VIAddVersionKey "LegalCopyright" "Tuna"

!define MUI_ICON "build/Tuna.ico"
!define MUI_UNICON "build/Tuna.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Tuna.exe"
!define MUI_FINISHPAGE_RUN_TEXT "$(OpenTuna)"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; In Italian on Italian Windows, otherwise English (picked automatically).
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Italian"
LangString OpenTuna ${LANG_ENGLISH} "Open Tuna"
LangString OpenTuna ${LANG_ITALIAN} "Apri Tuna"
LangString Needs64Bit ${LANG_ENGLISH} "Tuna needs 64-bit Windows 10 or 11."
LangString Needs64Bit ${LANG_ITALIAN} "Tuna richiede Windows 10 o 11 a 64 bit."
LangString TunaOpen ${LANG_ENGLISH} "Tuna is open. It will be closed to continue."
LangString TunaOpen ${LANG_ITALIAN} "Tuna è aperto. Verrà chiuso per continuare."
LangString DeleteSettings ${LANG_ENGLISH} "Also delete Tuna's settings on this PC?"
LangString DeleteSettings ${LANG_ITALIAN} "Vuoi eliminare anche le impostazioni di Tuna su questo PC?"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "$(Needs64Bit)" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Tuna"

; Tuna has to be closed before its files can be replaced.
!macro CloseTuna
  ; Started by Tuna as it closes (an update): give it up to 10 seconds to finish closing.
  ${If} ${Silent}
    StrCpy $2 0
    ${Do}
      nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq Tuna.exe" /NH | find /I "Tuna.exe"'
      Pop $0
      Pop $1
      ${If} $0 != 0
      ${OrIf} $2 >= 20
        ${ExitDo}
      ${EndIf}
      Sleep 500
      IntOp $2 $2 + 1
    ${Loop}
  ${EndIf}
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq Tuna.exe" /NH | find /I "Tuna.exe"'
  Pop $0 ; 0: it's running
  Pop $1
  ${If} $0 == 0
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "$(TunaOpen)" /SD IDOK IDOK +2
    Abort
    nsExec::Exec 'taskkill /IM Tuna.exe'
    Pop $0
    Sleep 1500
    nsExec::Exec 'taskkill /F /IM Tuna.exe'
    Pop $0
  ${EndIf}
!macroend

Section "Tuna"
  !insertmacro CloseTuna
  SetOutPath "$INSTDIR"
  File /r "build/publish/*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Tuna.lnk" "$INSTDIR\Tuna.exe"
  CreateShortcut "$DESKTOP\Tuna.lnk" "$INSTDIR\Tuna.exe"

  ; Listed in Settings → Apps, so it can be removed like any app.
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Tuna"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Tuna"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Tuna.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  ; Updating from inside Tuna ("Tuna-windows.exe /S /UPDATE"): open it again when done.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\Tuna.exe"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  !insertmacro CloseTuna
  Delete "$SMPROGRAMS\Tuna.lnk"
  Delete "$DESKTOP\Tuna.lnk"
  RMDir /r "$LOCALAPPDATA\Programs\Tuna"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; Settings and the sign-in (%LOCALAPPDATA%\Tuna) stay unless asked.
  MessageBox MB_YESNO|MB_ICONQUESTION "$(DeleteSettings)" /SD IDNO IDNO keep
  RMDir /r "$LOCALAPPDATA\Tuna"
  keep:
SectionEnd
