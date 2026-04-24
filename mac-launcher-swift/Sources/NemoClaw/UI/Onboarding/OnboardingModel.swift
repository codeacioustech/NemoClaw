import Foundation
import Observation

@Observable
final class OnboardingModel {
    enum Step: Int, CaseIterable { case workspace, team, connectors, microapps, done }

    var step: Step = .workspace
    var workspaceType: String = ""
    var teamSize: String = ""
    var techExperience: String = ""
    var connectors: Set<String> = []
    var microapps: Set<String> = []

    var canAdvance: Bool {
        switch step {
        case .workspace: !workspaceType.isEmpty && !teamSize.isEmpty && !techExperience.isEmpty
        case .team: true
        case .connectors: true
        case .microapps: true
        case .done: false
        }
    }

    func next() {
        if let next = Step(rawValue: step.rawValue + 1) { step = next }
    }

    func back() {
        if let prev = Step(rawValue: step.rawValue - 1) { step = prev }
    }

    func persist() throws {
        var cfg = (try? LauncherConfigStore.load()) ?? LauncherConfig()
        cfg.onboarding = LauncherConfig.OnboardingData(
            workspaceType: workspaceType.isEmpty ? nil : workspaceType,
            teamSize: teamSize.isEmpty ? nil : teamSize,
            techExperience: techExperience.isEmpty ? nil : techExperience,
            connectors: Array(connectors),
            microapps: Array(microapps)
        )
        cfg.onboardingComplete = true
        cfg.launcherSetupComplete = true
        try LauncherConfigStore.save(cfg)
    }
}
