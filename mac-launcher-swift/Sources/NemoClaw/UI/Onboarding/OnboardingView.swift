import SwiftUI

struct OnboardingView: View {
    @State private var model = OnboardingModel()
    var onComplete: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ProgressView(value: Double(model.step.rawValue),
                         total: Double(OnboardingModel.Step.allCases.count - 1))
                .padding()

            Group {
                switch model.step {
                case .workspace: WorkspaceStep(model: model)
                case .team:      TeamStep(model: model)
                case .connectors: ConnectorsStep(model: model)
                case .microapps: MicroappsStep(model: model)
                case .done:      EmptyView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack {
                if model.step.rawValue > 0 {
                    Button("Back") { model.back() }
                }
                Spacer()
                Button(model.step == .microapps ? "Finish" : "Next") {
                    if model.step == .microapps {
                        try? model.persist()
                        onComplete()
                    } else {
                        model.next()
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canAdvance)
            }
            .padding()
        }
        .frame(minWidth: 640, minHeight: 480)
    }
}

private struct WorkspaceStep: View {
    @Bindable var model: OnboardingModel
    var body: some View {
        Form {
            Section("Tell us about your workspace") {
                Picker("Workspace type", selection: $model.workspaceType) {
                    Text("Select…").tag("")
                    ForEach(["Personal", "Team", "Enterprise"], id: \.self) { Text($0).tag($0) }
                }
                Picker("Team size", selection: $model.teamSize) {
                    Text("Select…").tag("")
                    ForEach(["Just me", "2–10", "11–50", "50+"], id: \.self) { Text($0).tag($0) }
                }
                Picker("Technical experience", selection: $model.techExperience) {
                    Text("Select…").tag("")
                    ForEach(["Beginner", "Intermediate", "Advanced"], id: \.self) { Text($0).tag($0) }
                }
            }
        }
        .formStyle(.grouped)
    }
}

private struct TeamStep: View {
    @Bindable var model: OnboardingModel
    var body: some View {
        ContentUnavailableView(
            "Invite teammates",
            systemImage: "person.2",
            description: Text("Team invites will be available soon. Click Next to continue.")
        )
    }
}

private struct ConnectorsStep: View {
    @Bindable var model: OnboardingModel
    private let options = ["Slack", "GitHub", "Google Drive", "Notion", "OneDrive"]
    var body: some View {
        Form {
            Section("Pick integrations you'd like to enable") {
                ForEach(options, id: \.self) { name in
                    Toggle(name, isOn: Binding(
                        get: { model.connectors.contains(name) },
                        set: { on in
                            if on { model.connectors.insert(name) }
                            else { model.connectors.remove(name) }
                        }
                    ))
                }
            }
        }
        .formStyle(.grouped)
    }
}

private struct MicroappsStep: View {
    @Bindable var model: OnboardingModel
    private let options = ["Chat", "Workflows", "Folder Mounts", "Web Search"]
    var body: some View {
        Form {
            Section("Pick microapps to surface in the sidebar") {
                ForEach(options, id: \.self) { name in
                    Toggle(name, isOn: Binding(
                        get: { model.microapps.contains(name) },
                        set: { on in
                            if on { model.microapps.insert(name) }
                            else { model.microapps.remove(name) }
                        }
                    ))
                }
            }
        }
        .formStyle(.grouped)
    }
}
