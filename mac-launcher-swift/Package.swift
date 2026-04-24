// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NemoClaw",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "NemoClaw", targets: ["NemoClaw"])
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "6.29.0")
    ],
    targets: [
        .executableTarget(
            name: "NemoClaw",
            dependencies: [
                .product(name: "GRDB", package: "GRDB.swift")
            ],
            path: "Sources/NemoClaw",
            resources: [
                .copy("../../Resources/Info.plist")
            ]
        )
    ]
)
