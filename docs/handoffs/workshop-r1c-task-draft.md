# Workshop R1c: package the isolated public build and render image

Part of #2023. Implement the approved R1c slice after the local confinement proofs.

Package a reproducible, pinned image containing only the public module SDK/UI and required
build/browser tools. Accept bounded source data and use fixed offline build, test and render
recipes. Generated code runs only inside the disposable isolated container.

Verify worker/web compilation, browser rendering, malformed input rejection, bounded outputs,
resource limits and cleanup with automated disposable fixtures. Record the exact image identity
and distinguish local container evidence from deployment acceptance.

Keep Workshop execution unavailable. No shared service installation, deployment, restart,
module installation, merge or execution enablement is included. Runtime control integration
and durable attempt authority remain separate tasks.
