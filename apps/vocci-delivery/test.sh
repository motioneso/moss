#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/opt/jdk-21.0.12.1+1}"
export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p build/host-tests
javac --release 11 -d build/host-tests src/ai/moss/android/{HomeStatus,RingProblem,FirstOpen,RecoveryPolicy,LinkRouter,PollPolicy,RingAuth,RingProtocol,RingTelemetry,RecordingReminder,RetryPolicy,PcmWavWriter,RetrievalGate,HoldWatcher}.java test/ai/moss/android/*.java
java -cp build/host-tests ai.moss.android.HomeStatusTest
java -cp build/host-tests ai.moss.android.RingProblemTest
java -cp build/host-tests ai.moss.android.FirstOpenTest
java -cp build/host-tests ai.moss.android.RecoveryPolicyTest
java -cp build/host-tests ai.moss.android.LinkRouterTest
java -cp build/host-tests ai.moss.android.PollPolicyTest
java -cp build/host-tests ai.moss.android.RingAuthTest
java -cp build/host-tests ai.moss.android.ProtocolTest
java -cp build/host-tests ai.moss.android.RetrievalGateTest
java -cp build/host-tests ai.moss.android.HoldWatcherTest
java -cp build/host-tests ai.moss.android.RingTelemetryTest
java -cp build/host-tests ai.moss.android.RecordingReminderTest
java -Xmx32m -cp build/host-tests ai.moss.android.PcmWavWriterTest
python3 -m unittest discover -s upgrade-proof -p 'test_*.py'
./build.sh
