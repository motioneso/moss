# Builds the shared case list for the approval-route parity check (resolvePolicy, familyAllowsAutoRun).
import itertools, json
families = [None, "unreadable"]
for d, allowed, stored in itertools.product(["trusted_auto", "always_confirm"],
        [["always_confirm"], ["always_confirm", "trusted_auto"]], [None, "trusted_auto", "always_confirm"]):
    families.append({"default_tier": d, "allowed_tiers": allowed, "stored_tier": stored})
cases = []
for risk, ext, auto, cuy, fam in itertools.product(["read", "write", "outbound", "destructive"],
        [False, True], [False, True], [False, True], families):
    for co, ss, pcr, t, cwt in itertools.product([False, True], repeat=5):
        cases.append({"tool": {"risk": risk, "is_external": ext, "execution_auto": auto,
                               "confirm_under_yolo": cuy, "family": fam},
                      "call": {"confirm_override": co, "sorted_safe": ss, "per_call_resolved": pcr,
                               "tainted": t, "confirm_when_tainted": cwt}})
print(json.dumps(cases))
