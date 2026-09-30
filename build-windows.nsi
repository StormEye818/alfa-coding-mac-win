; AlfaProxi Windows installer - rebuilt with NSIS (bypass electron-builder wine requirement)
Unicode true
SetCompressor /SOLID lzma
CRCCheck on
XPStyle on

!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "AlfaProxi"
OutFile "AlfaProxi.Setup.0.2.2.exe"
InstallDir "$LOCALAPPDATA\Programs\AlfaProxi"
InstallDirRegKey HKCU "Software\AlfaProxi" "InstallLocation"
RequestExecutionLevel user
BrandingText "AlfaProxi 0.1.0"

; Install pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; Uninstall pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install" SecMain
  SetOutPath "$INSTDIR"
  File /r "dist/win-unpacked/*.*"

  ; Start menu + desktop shortcuts
  CreateDirectory "$SMPROGRAMS\AlfaProxi"
  CreateShortCut "$SMPROGRAMS\AlfaProxi\AlfaProxi.lnk" "$INSTDIR\AlfaProxi.exe"
  CreateShortCut "$SMPROGRAMS\AlfaProxi\Uninstall AlfaProxi.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\AlfaProxi.lnk" "$INSTDIR\AlfaProxi.exe"

  ; Uninstaller
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Registry (HKCU uninstall entry, per-user install)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi" "DisplayName" "AlfaProxi"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi" "DisplayVersion" "0.1.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi" "Publisher" "bigmiao"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi" "DisplayIcon" "$INSTDIR\AlfaProxi.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi" "NoRepair" 1
  WriteRegStr HKCU "Software\AlfaProxi" "InstallLocation" "$INSTDIR"

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall" SecUninstall
  Delete "$DESKTOP\AlfaProxi.lnk"
  Delete "$SMPROGRAMS\AlfaProxi\AlfaProxi.lnk"
  Delete "$SMPROGRAMS\AlfaProxi\Uninstall AlfaProxi.lnk"
  RMDir "$SMPROGRAMS\AlfaProxi"

  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlfaProxi"
  DeleteRegKey HKCU "Software\AlfaProxi"
SectionEnd
