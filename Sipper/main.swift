import AppKit

// Chrome launches this binary as a native messaging host; handle that before
// starting the GUI.
if NativeMessagingHost.shouldRun(arguments: CommandLine.arguments) {
    NativeMessagingHost.run()
}

SipperApp.main()
