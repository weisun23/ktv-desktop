!ifndef BUILD_UNINSTALLER
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE instDirLeave

  Function instDirLeave
    ; If the user selects a drive root like D:, append KTV Desktop.
    StrLen $2 $INSTDIR
    StrCmp $2 2 0 checkDriveRoot
    StrCpy $INSTDIR "$INSTDIR\KTV Desktop"
    Goto instDirLeaveDone
  checkDriveRoot:
    StrCmp $2 3 0 instDirLeaveDone
    StrCpy $1 $INSTDIR 1 1
    StrCmp $1 ":" 0 instDirLeaveDone
    StrCpy $INSTDIR "$INSTDIR\KTV Desktop"
  instDirLeaveDone:
  FunctionEnd
!endif
