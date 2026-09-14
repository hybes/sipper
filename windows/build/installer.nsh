; Registry entries the per-user installer adds for Sipper, and the uninstaller removes (not on
; upgrades, which run the previous uninstaller first):
;   sipper:   account imports from the browser extension and notification buttons open Sipper.
;   sip:, sips:, tel:   registered as capabilities, so Sipper is offered in Settings > Apps >
;             Default apps. Where no app handles a scheme yet, Sipper becomes its handler.
; Everything is under HKCU, so no administrator rights are needed. The "--" stops Chromium from
; reading anything in a link as a command-line switch.

!macro SipperRegisterScheme SCHEME
  WriteRegStr HKCU "Software\Classes\Sipper.Url.${SCHEME}" "" "URL:${SCHEME}"
  WriteRegStr HKCU "Software\Classes\Sipper.Url.${SCHEME}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\Sipper.Url.${SCHEME}\DefaultIcon" "" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\Sipper.Url.${SCHEME}\shell\open\command" "" '"$appExe" -- "%1"'
  WriteRegStr HKCU "Software\Hybes\Sipper\Capabilities\URLAssociations" "${SCHEME}" "Sipper.Url.${SCHEME}"
  ClearErrors
  ReadRegStr $0 HKCR "${SCHEME}" "URL Protocol"
  ${If} ${Errors}
    WriteRegStr HKCU "Software\Classes\${SCHEME}" "" "URL:${SCHEME}"
    WriteRegStr HKCU "Software\Classes\${SCHEME}" "URL Protocol" ""
    WriteRegStr HKCU "Software\Classes\${SCHEME}\DefaultIcon" "" "$appExe,0"
    WriteRegStr HKCU "Software\Classes\${SCHEME}\shell\open\command" "" '"$appExe" -- "%1"'
  ${EndIf}
!macroend

; Runs in the uninstaller, where $appExe does not exist; APP_EXECUTABLE_FILENAME is defined for both.
!macro SipperRemoveScheme SCHEME
  DeleteRegKey HKCU "Software\Classes\Sipper.Url.${SCHEME}"
  ReadRegStr $0 HKCU "Software\Classes\${SCHEME}\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
    DeleteRegKey HKCU "Software\Classes\${SCHEME}"
  ${EndIf}
!macroend

!macro customInstall
  WriteRegStr HKCU "Software\Classes\sipper" "" "URL:Sipper link"
  WriteRegStr HKCU "Software\Classes\sipper" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\sipper\DefaultIcon" "" "$appExe,0"
  WriteRegStr HKCU "Software\Classes\sipper\shell\open\command" "" '"$appExe" -- "%1"'

  WriteRegStr HKCU "Software\Hybes\Sipper\Capabilities" "ApplicationName" "Sipper"
  WriteRegStr HKCU "Software\Hybes\Sipper\Capabilities" "ApplicationDescription" "Makes and takes calls through your SIP accounts."
  WriteRegStr HKCU "Software\Hybes\Sipper\Capabilities" "ApplicationIcon" "$appExe,0"
  !insertmacro SipperRegisterScheme "tel"
  !insertmacro SipperRegisterScheme "sip"
  !insertmacro SipperRegisterScheme "sips"
  WriteRegStr HKCU "Software\RegisteredApplications" "Sipper" "Software\Hybes\Sipper\Capabilities"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\sipper"
    !insertmacro SipperRemoveScheme "tel"
    !insertmacro SipperRemoveScheme "sip"
    !insertmacro SipperRemoveScheme "sips"
    DeleteRegKey HKCU "Software\Hybes\Sipper"
    DeleteRegKey /ifempty HKCU "Software\Hybes"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Sipper"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.hybes.sipper"

    ; The browser helper, if it was installed from Settings.
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.hybes.sipper"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.hybes.sipper"
    DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.hybes.sipper"
    DeleteRegKey HKCU "Software\Vivaldi\NativeMessagingHosts\com.hybes.sipper"
    DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.hybes.sipper"

    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
