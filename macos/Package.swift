// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RocMindSpark",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "RocMindSpark", targets: ["RocMindSpark"]),
    ],
    targets: [
        .executableTarget(
            name: "RocMindSpark",
            path: "Sources/RocMindSpark"
        ),
        .testTarget(
            name: "RocMindSparkTests",
            dependencies: ["RocMindSpark"],
            path: "Tests/RocMindSparkTests"
        ),
    ]
)
