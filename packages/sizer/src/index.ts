export { kellySizer } from "./kelly.js";
export type { SizerOutput } from "./kelly.js";
export { riskGate } from "./gate.js";
export type { PortfolioState, GateConfig } from "./types.js";
export { DEFAULT_GATE_CONFIG } from "./types.js";
export { evaluateExit, DEFAULT_EXIT_CONFIG } from "./exit.js";
export type { ExitReason, ExitConfig, ExitInput, ExitDecision } from "./exit.js";
export { managePosition, DEFAULT_MANAGE_CONFIG } from "./averaging.js";
export type { ManageReason, ManageConfig, ManageInput, ManageResult } from "./averaging.js";
