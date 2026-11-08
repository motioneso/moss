# Policy parity with the TypeScript chat

Runs the same cases through the TypeScript rules and the Rust port and compares the answers.
Needs `tsx` from a checkout with `node_modules` (development only; Moss itself ships no Node).

| Check                                                                  | Cases                                                    | Last result |
| ---------------------------------------------------------------------- | -------------------------------------------------------- | ----------- |
| Agent permission asks (`classifyAcpPermission` vs `policy::classify`)  | 225 shared names, 127 OpenCode names against their twins | 0 differ    |
| Approval route (`resolvePolicy`, `familyAllowsAutoRun` vs `approvals`) | 14,336 (every combination)                               | 0 differ    |

```sh
python3 -I parity/gen-cases.py > /tmp/cases.json
tsx parity/ts-decide.ts /tmp/cases.json > /tmp/ts.json
cargo run -q --example policy-parity /tmp/cases.json > /tmp/rs.json

python3 -I parity/gen-route-cases.py > /tmp/route.json
tsx parity/ts-route.ts /tmp/route.json > /tmp/ts-route.json
cargo run -q --example route-parity /tmp/route.json > /tmp/rs-route.json
```

Compare each pair of outputs line by line; they are JSON arrays in case order.
