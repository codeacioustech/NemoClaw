import SwiftUI

enum SidebarItem: Hashable { case chat, workflows, folders }

struct MainView: View {
    @Environment(BootstrapModel.self) private var bootstrap
    @State private var selection: SidebarItem? = .chat
    @State private var showOnboarding: Bool = false

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("Workspace") {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right").tag(SidebarItem.chat)
                    Label("Workflows", systemImage: "flowchart").tag(SidebarItem.workflows)
                    Label("Folders", systemImage: "folder").tag(SidebarItem.folders)
                }
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 240)
        } detail: {
            switch selection {
            case .chat, .none:  ChatView()
            case .workflows:    WorkflowListView()
            case .folders:      FoldersView()
            }
        }
        .sheet(isPresented: $showOnboarding) {
            OnboardingView { showOnboarding = false }
        }
        .task {
            if !bootstrap.config.onboardingComplete { showOnboarding = true }
        }
    }
}

private struct FoldersView: View {
    @State private var folders: [(path: String, addedAt: String, stale: Bool)] = []

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text("Mounted folders").font(.title2).bold()
                Spacer()
                Button("Add…") { Task { await pick() } }
            }
            .padding(.horizontal)

            if folders.isEmpty {
                ContentUnavailableView("No folders mounted", systemImage: "folder.badge.plus",
                                       description: Text("Add a folder to let NemoClaw read and write files there."))
            } else {
                List(folders, id: \.path) { f in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(f.path).font(.body.monospaced())
                            Text("added \(f.addedAt)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if f.stale {
                            Text("stale").foregroundStyle(.orange)
                        }
                        Button("Remove") {
                            Task {
                                try? await Bookmarks.shared.unmount(f.path)
                                await reload()
                            }
                        }
                    }
                }
            }
        }
        .task { await reload() }
    }

    private func reload() async {
        folders = await Bookmarks.shared.listPublic()
    }

    @MainActor
    private func pick() async {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            _ = try? await Bookmarks.shared.mount(url)
            await reload()
        }
    }
}
