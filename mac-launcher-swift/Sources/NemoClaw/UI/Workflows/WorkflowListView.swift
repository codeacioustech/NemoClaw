import SwiftUI

struct WorkflowListView: View {
    @State private var workflows: [Workflow] = []

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text("Workflows").font(.title2).bold()
                Spacer()
                Button {
                    Task {
                        _ = try? await WorkflowStore.create(name: "Untitled Workflow")
                        await reload()
                    }
                } label: { Image(systemName: "plus") }
            }
            .padding(.horizontal)

            List(workflows) { wf in
                VStack(alignment: .leading) {
                    Text(wf.name).font(.headline)
                    if let d = wf.description, !d.isEmpty {
                        Text(d).font(.caption).foregroundStyle(.secondary)
                    }
                    Text("\(wf.steps.count) steps").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .task { await reload() }
    }

    private func reload() async {
        workflows = (try? await WorkflowStore.list()) ?? []
    }
}
