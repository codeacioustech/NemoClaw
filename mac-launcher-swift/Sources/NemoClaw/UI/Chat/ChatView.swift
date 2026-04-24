import SwiftUI

struct ChatView: View {
    @State private var vm = ChatViewModel()

    var body: some View {
        VStack(spacing: 0) {
            if vm.currentSessionId == nil {
                ContentUnavailableView("No chat selected",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Create a new session from the sidebar."))
                    .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(vm.messages) { msg in
                            MessageBubble(role: msg.role, content: msg.content)
                        }
                        if vm.isStreaming {
                            MessageBubble(role: "assistant", content: vm.streaming + "▍")
                        }
                    }
                    .padding()
                }
            }

            Divider()
            HStack {
                TextField("Ask NemoClaw…", text: $vm.input, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await vm.send() } }
                Button {
                    Task { await vm.send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(vm.input.trimmingCharacters(in: .whitespaces).isEmpty || vm.isStreaming)
            }
            .padding()
        }
        .task { await vm.loadSessions() }
    }
}

private struct MessageBubble: View {
    let role: String
    let content: String
    var body: some View {
        HStack(alignment: .top) {
            if role == "user" { Spacer(minLength: 40) }
            Text(content)
                .textSelection(.enabled)
                .padding(10)
                .background(role == "user" ? Color.accentColor.opacity(0.15) : Color(.windowBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            if role != "user" { Spacer(minLength: 40) }
        }
    }
}
