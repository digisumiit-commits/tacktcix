export type {
  AgentInfo,
  AgentRole,
  Issue,
  IssueStatus,
  IssuePriority,
  Comment,
  Interaction,
  InteractionKind,
  ContinuationPolicy,
  HeartbeatContext,
  HeartbeatCycleResult,
  HeartbeatPing,
  HeartbeatReport,
  MockPaperclipState,
} from "./types.js";

export {
  createMockPaperclipAPI,
  defaultAgent,
  defaultIssue,
} from "./mock-api.js";

export {
  runHeartbeatCycle,
  detectDependencyCycles,
  escalateStaleTask,
  getIdleBackoff,
} from "./loop.js";
