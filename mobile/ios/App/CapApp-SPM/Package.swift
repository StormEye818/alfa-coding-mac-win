// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2"),
        .package(name: "CapacitorCommunityBluetoothLe", path: "../../../node_modules/@capacitor-community/bluetooth-le"),
        .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app"),
        .package(name: "CapacitorShare", path: "../../../node_modules/@capacitor/share"),
        .package(name: "CapgoCapacitorFileSharer", path: "../../../node_modules/@capgo/capacitor-file-sharer"),
        .package(name: "CapgoCapacitorKeepAwake", path: "../../../node_modules/@capgo/capacitor-keep-awake"),
        .package(name: "DeedarbCapacitorTcpSocket", path: "../../../node_modules/@deedarb/capacitor-tcp-socket")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorCommunityBluetoothLe", package: "CapacitorCommunityBluetoothLe"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "CapgoCapacitorFileSharer", package: "CapgoCapacitorFileSharer"),
                .product(name: "CapgoCapacitorKeepAwake", package: "CapgoCapacitorKeepAwake"),
                .product(name: "DeedarbCapacitorTcpSocket", package: "DeedarbCapacitorTcpSocket")
            ]
        )
    ]
)
