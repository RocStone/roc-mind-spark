import AppKit

/// Single overlay status surface. Hide/show reuse this view; never stacked.
final class CanvasStatusView: NSView {
    var onRetry: (() -> Void)?

    private let titleField = NSTextField(labelWithString: "")
    private let bodyField = NSTextField(wrappingLabelWithString: "")
    private let retryButton = NSButton(title: "", target: nil, action: nil)
    private let stack = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor

        titleField.maximumNumberOfLines = 2
        titleField.lineBreakMode = .byWordWrapping
        bodyField.maximumNumberOfLines = 0
        bodyField.lineBreakMode = .byWordWrapping
        bodyField.isSelectable = true
        retryButton.bezelStyle = .rounded
        retryButton.target = self
        retryButton.action = #selector(retryTapped)

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(titleField)
        stack.addArrangedSubview(bodyField)
        stack.addArrangedSubview(retryButton)
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 48),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -48),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
            bodyField.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func showStarting() {
        applyFonts()
        titleField.stringValue = L10n.t("error.starting")
        bodyField.stringValue = ""
        bodyField.isHidden = true
        retryButton.isHidden = true
        retryButton.isEnabled = false
        isHidden = false
    }

    func showFailure(message: String) {
        applyFonts()
        titleField.stringValue = L10n.t("error.title")
        bodyField.stringValue = message
        bodyField.isHidden = false
        retryButton.title = L10n.t("error.retry")
        retryButton.isHidden = false
        retryButton.isEnabled = true
        isHidden = false
    }

    func refreshFailure(message: String) {
        guard !retryButton.isHidden else { return }
        applyFonts()
        titleField.stringValue = L10n.t("error.title")
        bodyField.stringValue = message
        retryButton.title = L10n.t("error.retry")
    }

    private func applyFonts() {
        let titleFont: NSFont = L10n.isChinese
            ? (NSFont(name: "PingFang SC", size: 22) ?? .systemFont(ofSize: 22, weight: .semibold))
            : .systemFont(ofSize: 22, weight: .semibold)
        let bodyFont: NSFont = L10n.isChinese
            ? (NSFont(name: "PingFang SC", size: 15) ?? .systemFont(ofSize: 15))
            : .systemFont(ofSize: 15)
        titleField.font = titleFont
        bodyField.font = bodyFont
        retryButton.font = bodyFont
    }

    @objc private func retryTapped() {
        onRetry?()
    }
}
