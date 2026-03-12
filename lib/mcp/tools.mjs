/**
 * MCP Tool Definitions for Swarm Agent Coordination
 *
 * These tools enable agents to report progress, results, and logs
 * to the swarm orchestrator via the MCP protocol.
 */

export const SWARM_TOOLS = [
  {
    name: "swarm_report_progress",
    description: "Report your execution progress to the swarm orchestrator. Call this periodically as you complete steps.",
    inputSchema: {
      type: "object",
      properties: {
        percent: {
          type: "number",
          description: "Completion percentage 0-100"
        },
        step: {
          type: "string",
          description: "Current step description"
        },
        files_touched: {
          type: "array",
          items: { type: "string" },
          description: "Files read/modified so far"
        }
      },
      required: ["percent", "step"]
    }
  },
  {
    name: "swarm_report_result",
    description: "Report your final result when task is complete or failed. Call this once at the end.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["completed", "failed", "partial"],
          description: "Final status"
        },
        summary: {
          type: "string",
          description: "Brief summary of what was done"
        },
        files_modified: {
          type: "array",
          items: { type: "string" },
          description: "Files that were modified"
        },
        issues: {
          type: "array",
          items: { type: "string" },
          description: "Issues or warnings encountered"
        }
      },
      required: ["status", "summary"]
    }
  },
  {
    name: "swarm_get_context",
    description: "Read shared context from the orchestrator — task details, scope, or prior agent results.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          enum: ["task", "scope", "prior_results", "config"],
          description: "Context key to read"
        }
      },
      required: ["key"]
    }
  },
  {
    name: "swarm_log",
    description: "Send a structured log message to the orchestrator for visibility.",
    inputSchema: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: ["info", "warn", "error"],
          description: "Log level"
        },
        message: {
          type: "string",
          description: "Log message"
        }
      },
      required: ["level", "message"]
    }
  }
];
