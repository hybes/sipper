import Foundation

struct ContactNumber: Identifiable, Codable, Hashable {
    var id: UUID
    var label: String
    var number: String

    init(id: UUID = UUID(), label: String = "Work", number: String) {
        self.id = id
        self.label = label
        self.number = number
    }

    private enum CodingKeys: String, CodingKey { case id, label, number }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.decode(.id, default: UUID())
        label = c.decode(.label, default: "Work")
        number = c.decode(.number, default: "")
    }

    static let labels = ["Work", "Mobile", "Home", "Extension", "Main", "Other"]
}

struct Contact: Identifiable, Codable, Hashable {
    var id: UUID
    var name: String
    var company: String
    var numbers: [ContactNumber]
    /// Account to call from; nil means "whatever is selected in the dialer".
    var preferredAccountID: UUID?
    var isFavorite: Bool
    var notes: String
    var createdAt: Date
    var updatedAt: Date

    init(id: UUID = UUID(),
         name: String,
         company: String = "",
         numbers: [ContactNumber] = [],
         preferredAccountID: UUID? = nil,
         isFavorite: Bool = false,
         notes: String = "",
         createdAt: Date = Date.stamp(),
         updatedAt: Date? = nil) {
        self.id = id
        self.name = name
        self.company = company
        self.numbers = numbers
        self.preferredAccountID = preferredAccountID
        self.isFavorite = isFavorite
        self.notes = notes
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, company, numbers, preferredAccountID, isFavorite, notes, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = c.decode(.name, default: "")
        company = c.decode(.company, default: "")
        numbers = c.decode(.numbers, default: [ContactNumber]())
        preferredAccountID = c.decodeOptional(.preferredAccountID)
        isFavorite = c.decode(.isFavorite, default: false)
        notes = c.decode(.notes, default: "")
        createdAt = c.decode(.createdAt, default: Date())
        updatedAt = c.decode(.updatedAt, default: createdAt)
    }

    var primaryNumber: String? { numbers.first?.number }

    var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map(String.init)
        return letters.joined().uppercased()
    }

    /// True when any stored number matches the dialled digits.
    func matches(number: String) -> Bool {
        let wanted = SIPAccount.normaliseDialString(number)
        guard !wanted.isEmpty else { return false }
        return numbers.contains { SIPAccount.normaliseDialString($0.number) == wanted }
    }
}
