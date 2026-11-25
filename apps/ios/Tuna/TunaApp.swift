import SwiftUI
import UIKit

@main
struct TunaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            WebView()
                .ignoresSafeArea()
                .background(Color(red: 7 / 255, green: 6 / 255, blue: 12 / 255))
                .preferredColorScheme(.dark)
        }
    }
}

private struct WebView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController { WebViewController() }
    func updateUIViewController(_ controller: WebViewController, context: Context) {}
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    /// iOS wakes the app when background downloads finish: the store wraps up, then tells iOS.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        OfflineStore.shared.backgroundCompletion = completionHandler
    }
}
