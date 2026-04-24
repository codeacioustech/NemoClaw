import SwiftUI

struct SplashView: View {
    @Bindable var model: BootstrapModel

    var body: some View {
        VStack(spacing: 24) {
            Text("NemoClaw")
                .font(.system(size: 36, weight: .semibold, design: .rounded))

            ProgressView(value: model.progress)
                .progressViewStyle(.linear)
                .frame(maxWidth: 360)

            Text(model.message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if let err = model.error {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .padding(.horizontal)
            }
        }
        .padding(40)
        .frame(minWidth: 480, minHeight: 280)
    }
}
