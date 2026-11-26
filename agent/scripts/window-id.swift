// Prints the window number of the first normal window of process
// CommandLine.arguments[1], for `screencapture -l`. Windows on another Space
// count too: the one the app opened may not be on the visible one.
//
//   swift agent/scripts/window-id.swift <pid>
import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1, let pid = Int(CommandLine.arguments[1]) else {
    exit(2)
}
let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows {
    let owner = window[kCGWindowOwnerPID as String] as? Int
    let layer = window[kCGWindowLayer as String] as? Int
    // The menu bar the app owns is a window too, a short one.
    let bounds = window[kCGWindowBounds as String] as? [String: Any]
    let height = (bounds?["Height"] as? Double) ?? 0
    if owner == pid, layer == 0, height > 200, let number = window[kCGWindowNumber as String] as? Int {
        print(number)
        exit(0)
    }
}
exit(1)
