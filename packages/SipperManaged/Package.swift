// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SipperManaged",
    platforms: [.macOS(.v14), .iOS(.v16)],
    products: [.library(name: "SipperManaged", targets: ["SipperManaged"])],
    dependencies: [
        .package(url: "https://github.com/openid/AppAuth-iOS.git", exact: "3.0.0"),
        .package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.17.0"),
    ],
    targets: [
        .target(name: "SipperManaged", dependencies: [.product(name: "AppAuth", package: "AppAuth-iOS"), .product(name: "LiveKit", package: "client-sdk-swift")], resources: [.copy("Resources/Licenses")]),
        .testTarget(name: "SipperManagedTests", dependencies: ["SipperManaged"]),
    ]
)
