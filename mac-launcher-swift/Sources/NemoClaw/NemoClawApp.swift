import SwiftUI

@main
struct NemoClawApp: App {
    @State private var bootstrap = BootstrapModel()

    var body: some Scene {
        Window("NemoClaw", id: "splash") {
            SplashView(model: bootstrap)
                .task { await bootstrap.run() }
        }
        .windowResizability(.contentSize)
        .defaultSize(width: 520, height: 320)

        Window("NemoClaw", id: "main") {
            MainView()
                .environment(bootstrap)
        }
        .defaultSize(width: 1200, height: 800)
    }
}
