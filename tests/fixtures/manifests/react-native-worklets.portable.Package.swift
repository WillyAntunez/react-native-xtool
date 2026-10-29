// swift-tools-version: 6.0

import Foundation
import PackageDescription

let packageDirectory = Context.packageDirectory

func readPackageVersion() -> String {
    let url = URL(fileURLWithPath: packageDirectory).appendingPathComponent("package.json")
    let data = try! Data(contentsOf: url)
    let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    return json["version"] as! String
}

func readJSONObject(at url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else {
        return nil
    }
    let object = try? JSONSerialization.jsonObject(with: data)
    return object as? [String: Any]
}

// NSNumber needs a boolean check to tell booleans apart from integers.
// CFGetTypeID/CFBooleanGetTypeID only exist on Darwin; this manifest is also
// evaluated on Linux hosts (swift-corelibs-foundation), where JSON booleans
// are NSNumbers with objCType "c".
func stringifyFlagValue(_ value: Any) -> String? {
    if let number = value as? NSNumber {
#if canImport(Darwin)
        let isBoolean = CFGetTypeID(number) == CFBooleanGetTypeID()
#else
        let isBoolean = String(cString: number.objCType) == "c"
#endif
        if isBoolean {
            return number.boolValue ? "true" : "false"
        }
        return number.stringValue
    }
    if let string = value as? String {
        return string
    }
    return nil
}
let package = Package(
    name: "RNWorklets",
    platforms: [.iOS(.v15)],
    products: [.library(name: "RNWorklets", targets: ["RNWorklets"])],
    targets: [.target(name: "RNWorklets", path: ".")]
)
