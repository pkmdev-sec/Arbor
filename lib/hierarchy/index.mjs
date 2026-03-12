/**
 * Hierarchical Agent Coordination Module
 *
 * Provides multi-level hierarchical decomposition and coordination for
 * distributed agent swarms. Enables recursive task splitting with:
 * - Task decomposition with dependency graph analysis
 * - Sub-coordinators managing sub-swarms
 * - Scoped IPC message bus with topic hierarchies
 * - Semantic conflict resolution across levels
 * - Budget enforcement and resource management
 *
 * @module hierarchy
 */

// Decomposition engine - analyzes tasks and builds hierarchical execution trees
export {
  analyzeTaskScope,
  buildDependencyGraph,
  findModuleBoundaries,
  decomposeHierarchically,
  estimateAgentBudget,
} from "./decomposer.mjs";

// Sub-coordinator agent - manages scoped sub-swarms
export {
  SubCoordinator,
  spawnSubCoordinator,
  createWorkerTask,
} from "./sub-coordinator.mjs";

// Scoped message bus - hierarchical IPC with topic namespacing
export {
  ScopedBus,
  HierarchicalTopics,
  createChildScope,
  aggregateProgress,
  createScopedBus,
} from "./scoped-bus.mjs";

// Result aggregator - bottom-up result collection with conflict detection
export {
  aggregateSubCoordinatorResults,
  crossModuleConflictDetection,
  buildHierarchicalContract,
  buildFinalResult,
  generateMergeReport,
  detectFileLevelConflicts,
  createConflictSummary,
} from "./aggregator.mjs";

// Resource governor - budget allocation, limit enforcement, cost tracking
export {
  ResourceGovernor,
  GovernorLimitError,
} from "./governor.mjs";
