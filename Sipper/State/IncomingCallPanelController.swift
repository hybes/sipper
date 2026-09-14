import AppKit
import Combine
import SwiftUI

/// A borderless floating alert that shows ringing calls on every Space, even when
/// the main window is hidden. Sized to its SwiftUI content and pinned to the
/// top-right corner of the screen with the menu bar.
@MainActor
final class IncomingCallPanelController {
    private let panel: NSPanel
    private let hostingView: NSHostingView<AnyView>
    private unowned let state: AppState
    private var cancellable: AnyCancellable?

    private static let width: CGFloat = 400

    init(state: AppState) {
        self.state = state
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: IncomingCallPanelController.width, height: 160),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered,
                            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.becomesKeyOnlyIfNeeded = true
        panel.animationBehavior = .alertPanel

        let root = AnyView(IncomingCallView().environmentObject(state).frame(width: IncomingCallPanelController.width))
        let hosting = NSHostingView(rootView: root)
        hosting.sizingOptions = [.intrinsicContentSize]
        panel.contentView = hosting
        self.hostingView = hosting
        self.panel = panel

        cancellable = state.$calls
            .map { calls in calls.filter { $0.state == .incoming }.count }
            .removeDuplicates()
            .sink { [weak self] count in
                guard let self, self.panel.isVisible, count > 0 else { return }
                self.fitToContent(keepTopRight: true)
            }
    }

    func present(call: CallSnapshot) {
        fitToContent(keepTopRight: panel.isVisible)
        if !panel.isVisible {
            moveToTopRight()
        }
        panel.orderFrontRegardless()
    }

    func dismiss(callID: Int) {
        let stillRinging = state.calls.contains { $0.id != callID && $0.state == .incoming }
        if !stillRinging {
            panel.orderOut(nil)
        }
    }

    func close() {
        panel.orderOut(nil)
    }

    private func fitToContent(keepTopRight: Bool) {
        hostingView.layoutSubtreeIfNeeded()
        let size = hostingView.fittingSize
        let topRight = NSPoint(x: panel.frame.maxX, y: panel.frame.maxY)
        panel.setContentSize(NSSize(width: Self.width, height: max(size.height, 120)))
        if keepTopRight {
            panel.setFrameTopLeftPoint(NSPoint(x: topRight.x - Self.width, y: topRight.y))
        }
    }

    private func moveToTopRight() {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let frame = screen.visibleFrame
        panel.setFrameTopLeftPoint(NSPoint(x: frame.maxX - Self.width - 16, y: frame.maxY - 12))
    }
}
