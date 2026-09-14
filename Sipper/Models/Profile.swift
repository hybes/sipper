import Foundation

/// A named group of SIP accounts (for example one per PBX or customer). Disabling a
/// profile unregisters every account in it.
struct Profile: Identifiable, Codable, Hashable {
    var id: UUID
    var name: String
    var colorName: ProfileColor
    var iconName: String
    var isEnabled: Bool
    var sortOrder: Int
    var createdAt: Date
    var updatedAt: Date

    init(id: UUID = UUID(),
         name: String,
         colorName: ProfileColor = .blue,
         iconName: String = "building.2",
         isEnabled: Bool = true,
         sortOrder: Int = 0,
         createdAt: Date = Date.stamp(),
         updatedAt: Date? = nil) {
        self.id = id
        self.name = name
        self.colorName = colorName
        self.iconName = iconName
        self.isEnabled = isEnabled
        self.sortOrder = sortOrder
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, colorName, iconName, isEnabled, sortOrder, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = c.decode(.name, default: "Profile")
        colorName = c.decode(.colorName, default: ProfileColor.blue)
        iconName = c.decode(.iconName, default: "building.2")
        isEnabled = c.decode(.isEnabled, default: true)
        sortOrder = c.decode(.sortOrder, default: 0)
        createdAt = c.decode(.createdAt, default: Date())
        updatedAt = c.decode(.updatedAt, default: createdAt)
    }

    static let defaultName = "Personal"
}

enum ProfileColor: String, Codable, CaseIterable, Identifiable, Hashable {
    case blue, green, orange, red, purple, teal, pink, indigo, gray

    var id: String { rawValue }

    var displayName: String { rawValue.capitalized }
}

/// Icons offered in the profile editor. Any SF Symbol name is valid in the model.
enum ProfileIcon {
    static let choices: [String] = [
        "building.2", "briefcase", "house", "phone.badge.waveform", "network",
        "server.rack", "person.2", "star", "flag", "globe", "wrench.and.screwdriver",
        "headphones", "antenna.radiowaves.left.and.right", "cloud", "storefront",
    ]
}
