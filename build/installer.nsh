!macro customUnInstall
  ; Remove only native-messaging registrations owned by this exact signed app
  ; before NSIS deletes the executable that implements the cleanup boundary.
  IfFileExists "$INSTDIR\Overlook.exe" 0 +2
  ExecWait '"$INSTDIR\Overlook.exe" --unregister-native-host'
!macroend
