// external-modules/meals/src/web/index.ts
//
// Contract v2 web entry. CSS travels on the contract; the host confines and mounts it.
import { Root } from "./root";
import { MODULE_STYLES } from "./styles";

export default { contractVersion: 2, Root, css: MODULE_STYLES };
