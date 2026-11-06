; Лаунчер ставится внутрь своей единственной папки, а не в %LOCALAPPDATA%\Programs.
!macro preInit
  SetShellVarContext current
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$APPDATA\.lumorrix-launcher\app"
!macroend

; Этот код выполняется и при автообновлении, поэтому данные трогаем только при настоящем удалении.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    ${if} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "Удалить также сборку, настройки и свои моды?$\r$\n$\r$\nЕсли нажать «Нет», папка game останется на компьютере." /SD IDNO IDYES`
      RMDir /r "$APPDATA\.lumorrix-launcher\game"
    ${endIf}
    RMDir /r "$APPDATA\.lumorrix-launcher\minecraft"
    RMDir /r "$APPDATA\.lumorrix-launcher\runtime"
    RMDir /r "$APPDATA\.lumorrix-launcher\data"
    RMDir /r "$APPDATA\.lumorrix-launcher\logs"
    RMDir /r "$APPDATA\.lumorrix-launcher\tmp"
    RMDir /r "$LOCALAPPDATA\lumorrix-launcher-updater"
    ; Без /r: корневая папка удалится, только если в ней ничего не осталось.
    RMDir "$APPDATA\.lumorrix-launcher"
  ${endIf}
!macroend
