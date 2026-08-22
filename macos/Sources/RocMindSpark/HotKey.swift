import Carbon
import Foundation

/// Process-wide hotkeys. Carbon RegisterEventHotKey works without Accessibility
/// permission and fires while another app is fullscreen.
final class HotKeyCenter: @unchecked Sendable {
    static let shared = HotKeyCenter()

    private var handlers: [UInt32: () -> Void] = [:]
    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var handlerRef: EventHandlerRef?
    private let lock = NSLock()

    private init() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let context = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, userData in
                guard let userData, let event else { return noErr }
                Unmanaged<HotKeyCenter>.fromOpaque(userData).takeUnretainedValue().handle(event)
                return noErr
            },
            1,
            &eventType,
            context,
            &handlerRef
        )
    }

    func register(id: UInt32, chord: KeyChord, handler: @escaping () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        unregisterLocked(id: id)
        handlers[id] = handler
        var ref: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: 0x524D5350, id: id) // 'RMSP'
        let status = RegisterEventHotKey(
            chord.keyCode,
            chord.carbonModifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &ref
        )
        refs[id] = ref
        Paths.log("RegisterEventHotKey id=\(id) status=\(status) key=\(chord.display)")
    }

    func unregister(id: UInt32) {
        lock.lock()
        defer { lock.unlock() }
        unregisterLocked(id: id)
    }

    private func unregisterLocked(id: UInt32) {
        if let ref = refs[id] {
            UnregisterEventHotKey(ref)
            refs[id] = nil
        }
        handlers[id] = nil
    }

    private func handle(_ event: EventRef) {
        var hotKeyID = EventHotKeyID()
        let err = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )
        guard err == noErr else { return }
        lock.lock()
        let handler = handlers[hotKeyID.id]
        lock.unlock()
        handler?()
    }
}

enum CarbonModifiers {
    static let controlOption: UInt32 = UInt32(controlKey | optionKey)
    static let hyper: UInt32 = UInt32(cmdKey | controlKey | optionKey | shiftKey)
}
