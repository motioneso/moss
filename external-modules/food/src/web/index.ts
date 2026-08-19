// external-modules/food/src/web/index.ts
// Food Phase 1 (#926, #1701, plan §5 Task 6): external web entry — contract
// v2 Root (see root.tsx), ported from finance's index.ts. The bundle stays
// react-free: all React access goes through src/web/runtime.ts. CSS travels
// on the contract (not a self-injected <style>), so the host confines and
// mounts it (packages/module-css-confine, D9 #1388).
import { Root } from "./root";
import { MODULE_STYLES } from "./styles";

export default { contractVersion: 2, Root, css: MODULE_STYLES };
