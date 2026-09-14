import AppKit
import Combine
import SwiftUI

/// Status bar item with registration state, quick actions and Do Not Disturb.
@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
    private var item: NSStatusItem?
    private let state: AppState
    private var cancellables: Set<AnyCancellable> = []

    init(state: AppState) {
        self.state = state
        super.init()
        state.$settings.map(\.showMenuBarItem).removeDuplicates()
            .sink { [weak self] show in self?.setVisible(show) }
            .store(in: &cancellables)
        // @Published emits before the property is assigned; hop to the next main-loop turn before reading.
        state.$registrations.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.updateIcon() }.store(in: &cancellables)
        state.$calls.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.updateIcon() }.store(in: &cancellables)
        state.$settings.map(\.doNotDisturb).removeDuplicates().receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.updateIcon() }
            .store(in: &cancellables)
    }

    private func setVisible(_ visible: Bool) {
        if visible {
            guard item == nil else { return }
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            let menu = NSMenu()
            menu.delegate = self
            item.menu = menu
            self.item = item
            updateIcon()
        } else if let item {
            NSStatusBar.system.removeStatusItem(item)
            self.item = nil
        }
    }

    private func updateIcon() {
        guard let button = item?.button else { return }
        let symbol: String
        let description: String
        if state.hasActiveCalls {
            symbol = "phone.connection.fill"
            description = "Sipper, in a call"
        } else if state.settings.doNotDisturb {
            symbol = "phone.down.fill"
            description = "Sipper, do not disturb"
        } else if state.accounts.contains(where: { state.registration(for: $0.id).isRegistered }) {
            symbol = "phone.fill"
            description = "Sipper, registered"
        } else if state.accounts.contains(where: { state.registration(for: $0.id).isFailed }) {
            symbol = "phone.badge.waveform.fill"
            description = "Sipper, registration failed"
        } else {
            symbol = "phone"
            description = "Sipper"
        }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: description)
        image?.isTemplate = true
        button.image = image
        button.toolTip = description
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        if state.accounts.isEmpty {
            menu.addItem(disabled("No SIP accounts"))
        } else {
            for profile in state.profiles {
                let members = state.accounts(in: profile.id)
                guard !members.isEmpty else { continue }
                if state.profiles.count > 1 {
                    menu.addItem(disabled(profile.name))
                }
                for account in members {
                    let registration = state.registration(for: account.id)
                    let entry = NSMenuItem(title: "\(account.displayLabel) — \(registration.shortLabel)",
                                           action: #selector(selectAccount(_:)), keyEquivalent: "")
                    entry.target = self
                    entry.representedObject = account.id
                    entry.image = NSImage(systemSymbolName: registration.isRegistered ? "circle.fill" : (registration.isFailed ? "exclamationmark.circle.fill" : "circle.dotted"),
                                          accessibilityDescription: registration.shortLabel)
                    if let vm = state.voicemail[account.id], vm.newCount > 0 {
                        entry.title += " · \(vm.newCount) voicemail"
                    }
                    menu.addItem(entry)
                }
            }
        }

        menu.addItem(.separator())

        for call in state.calls {
            let title = "\(call.state == .incoming ? "Answer" : "Hang up"): \(call.displayName)"
            let entry = NSMenuItem(title: title, action: #selector(handleCall(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = call.id
            menu.addItem(entry)
        }
        if !state.calls.isEmpty { menu.addItem(.separator()) }

        let dial = NSMenuItem(title: "New Call…", action: #selector(newCall), keyEquivalent: "")
        dial.target = self
        menu.addItem(dial)

        let dnd = NSMenuItem(title: "Do Not Disturb", action: #selector(toggleDND), keyEquivalent: "")
        dnd.target = self
        dnd.state = state.settings.doNotDisturb ? .on : .off
        menu.addItem(dnd)

        let reregister = NSMenuItem(title: "Re-register All", action: #selector(reRegister), keyEquivalent: "")
        reregister.target = self
        reregister.isEnabled = !state.accounts.isEmpty
        menu.addItem(reregister)

        menu.addItem(.separator())
        let show = NSMenuItem(title: "Open Sipper", action: #selector(showApp), keyEquivalent: "")
        show.target = self
        menu.addItem(show)
        let quit = NSMenuItem(title: "Quit Sipper", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func selectAccount(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? UUID else { return }
        showApp()
        state.selection = .account(id)
    }

    @objc private func handleCall(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? Int, let call = state.calls.first(where: { $0.id == id }) else { return }
        if call.state == .incoming { state.answer(callID: id) } else { state.hangup(callID: id) }
    }

    @objc private func newCall() {
        showApp()
        state.selection = .dialer
    }

    @objc private func toggleDND() {
        state.toggleDoNotDisturb()
    }

    @objc private func reRegister() {
        state.reRegisterAll()
    }

    @objc private func showApp() {
        (NSApp.delegate as? AppDelegate)?.showMainWindow()
    }
}
