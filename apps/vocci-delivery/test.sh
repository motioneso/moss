#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/opt/jdk-21.0.12.1+1}"
export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p build/host-tests
javac --release 11 -d build/host-tests src/ai/moss/vocci/{RingAuth,RingProtocol,RingTelemetry,RecordingReminder,RetryPolicy,PcmWavWriter}.java test/ai/moss/vocci/*.java
java -cp build/host-tests ai.moss.vocci.RingAuthTest
java -cp build/host-tests ai.moss.vocci.ProtocolTest
java -cp build/host-tests ai.moss.vocci.RingTelemetryTest
java -cp build/host-tests ai.moss.vocci.RecordingReminderTest
java -Xmx32m -cp build/host-tests ai.moss.vocci.PcmWavWriterTest
python3 -m unittest discover -s upgrade-proof -p 'test_*.py'
./build.sh
