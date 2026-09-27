import Carbon
import Foundation

/// Process-wide hotkeys. Carbon RegisterEventHotKey works without Accessibility
/// permission and fires while another app is fullscreen.
final class HotKeyCenter: @unchecked Sendable {
    static let shared = HotKeyCenter()

    private var handlers: [UInt32: () -> Void] = [:]
    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var chords: [UInt32: KeyChord] = [:]
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

    /// Returns the Carbon status. On failure the chord that was registered
    /// for `id` before this call (if any) is registered again, so a bad
    /// chord never leaves the app without a working hotkey.
    @discardableResult
    func register(id: UInt32, chord: KeyChord, handler: @escaping () -> Void) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        let previous = chords[id].flatMap { chord in handlers[id].map { (chord, $0) } }
        unregisterLocked(id: id)
        let status = registerLocked(id: id, chord: chord, handler: handler)
        if status != noErr, let previous {
            let restored = registerLocked(id: id, chord: previous.0, handler: previous.1)
            Paths.log("RegisterEventHotKey restore previous id=\(id) status=\(restored) key=\(previous.0.display)")
        }
        return status
    }

    private func registerLocked(id: UInt32, chord: KeyChord, handler: @escaping () -> Void) -> OSStatus {
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
        Paths.log("RegisterEventHotKey id=\(id) status=\(status) key=\(chord.display)")
        guard status == noErr, let ref else { return status == noErr ? OSStatus(eventInternalErr) : status }
        refs[id] = ref
        handlers[id] = handler
        chords[id] = chord
        return noErr
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
        chords[id] = nil
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
