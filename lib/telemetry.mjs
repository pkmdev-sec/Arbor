/**
 * Telemetry: parse stderr/stdout for quality signals
 *
 * Extracted from agent-entry.mjs lines ~87-112.
 */

import { TOOL_CALL_RE } from "./config.mjs";

export function parseTelemetry(stderrText, stdoutText) {
  const toolCounts = { Read: 0, Grep: 0, Bash: 0, Edit: 0, Write: 0, Glob: 0, total: 0 };
  for (const line of stderrText.split("\n")) {
    const m = line.match(TOOL_CALL_RE);
    if (m) {
      const tool = m[1];
      if (tool in toolCounts) toolCounts[tool]++;
      toolCounts.total++;
    }
  }

  const checklist = { pass: 0, fail: 0, skip: 0 };
  for (const line of stdoutText.split("\n")) {
    if (/\[PASS\]/i.test(line)) checklist.pass++;
    if (/\[FAIL\]/i.test(line)) checklist.fail++;
    if (/\[SKIP\]/i.test(line)) checklist.skip++;
  }

  return {
    tool_calls: toolCounts,
    completion_checklist: checklist,
    quality_signals: {
      has_checklist: checklist.pass + checklist.fail + checklist.skip > 0,
    },
  };
}
