package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// DataPoller provides file-based data when IPC bus is unavailable.
// Polling runs in a background goroutine to avoid blocking the TUI event loop.
type DataPoller struct {
	interval time.Duration
	resultCh chan PollResult
	polling  atomic.Bool
}

// NewDataPoller creates a poller with the given interval.
func NewDataPoller(interval time.Duration) *DataPoller {
	return &DataPoller{
		interval: interval,
		resultCh: make(chan PollResult, 1),
	}
}

// PollResult holds data from all polled sources.
type PollResult struct {
	Agents      []Agent
	Worktrees   []WorktreeInfo
	Resources   ResourceSnapshot
	IPCEvents   []IPCEvent
	ParseErrors int // Bug K fix: Track JSON parse failures
}

// IPCEvent represents a single IPC log event from ipc.jsonl.
// Two schemas coexist: the orchestrator emits {from, to, content, meta},
// while the MCP coordinator emits {agentId, step, percent, files_touched}.
// After normalization the from/to/content fields are always populated.
type IPCEvent struct {
	Timestamp int64                  `json:"ts"`
	From      string                 `json:"from"`
	To        string                 `json:"to"`
	Type      string                 `json:"type"`
	Content   string                 `json:"content"`
	Meta      map[string]interface{} `json:"meta"`
	// MCP coordinator fields (backward compat with old logs)
	AgentId string `json:"agentId"`
	Step    string `json:"step"`
	Percent int    `json:"percent"`
}

// WorktreeInfo holds information about a git worktree.
type WorktreeInfo struct {
	Path   string
	Branch string
	Bare   bool
}

type pollTickMsg struct {
	result PollResult
}

// PollTick returns a Bubble Tea command that fires periodically.
// The actual polling runs in a background goroutine to never block the TUI.
func (p *DataPoller) PollTick() tea.Cmd {
	return tea.Tick(p.interval, func(t time.Time) tea.Msg {
		// Bug J fix: Use atomic bool to ensure only one poll runs at a time
		// This prevents overlapping polls from causing concurrent model mutation
		if p.polling.CompareAndSwap(false, true) {
			go func() {
				result := p.Poll()
				select {
				case p.resultCh <- result:
				default:
					// Drop if channel full (previous result not consumed)
				}
				p.polling.Store(false)
			}()
		}
		// Return whatever is available (non-blocking)
		select {
		case result := <-p.resultCh:
			return pollTickMsg{result: result}
		default:
			// No result ready yet — return empty tick (TUI stays responsive)
			return pollTickMsg{}
		}
	})
}

// Poll gathers data from all available sources.
func (p *DataPoller) Poll() PollResult {
	var result PollResult

	// 1. Git worktrees
	result.Worktrees = pollWorktrees()

	// 2. Result files in /tmp
	// Bug K fix: Track parse errors
	tmpAgents, tmpErrors := pollResultFiles()
	result.Agents = append(result.Agents, tmpAgents...)
	result.ParseErrors += tmpErrors

	// 3. Running Claude processes — disabled (produces noisy claude-pid-* entries
	// that lack useful data. Swarm result files are the authoritative source.)
	// procAgents := pollProcesses()
	// result.Agents = append(result.Agents, procAgents...)

	// 4. Swarm run directories
	swarmAgents, swarmErrors := pollSwarmDirs()
	result.Agents = append(result.Agents, swarmAgents...)
	result.ParseErrors += swarmErrors

	// 5. Arbor run directories
	arborAgents := pollArborDirs()
	result.Agents = append(result.Agents, arborAgents...)

	// FIX H19: Combine deduplication and filtering into a single pass
	seen := map[string]bool{}
	filtered := make([]Agent, 0, len(result.Agents))
	for _, a := range result.Agents {
		// Skip duplicates
		if seen[a.ID] {
			continue
		}
		seen[a.ID] = true

		// Skip filtered IDs
		if strings.HasPrefix(a.ID, "claude-pid-") || strings.HasPrefix(a.ID, "proc-") {
			continue
		}
		if strings.HasSuffix(a.ID, ".progress") || a.ID == "verify-result" {
			continue
		}

		filtered = append(filtered, a)
	}
	result.Agents = filtered

	// Build resource snapshot
	active := 0
	var totalCost float64
	for _, a := range result.Agents {
		if a.Status == "running" {
			active++
		}
		totalCost += a.Cost
	}

	// Dynamic max values
	maxAgents := 10
	if len(result.Agents) > maxAgents {
		maxAgents = len(result.Agents)
	}

	maxMemoryMB := 4096.0
	estimatedMemory := float64(active) * 256.0
	if estimatedMemory > maxMemoryMB {
		maxMemoryMB = estimatedMemory * 1.2 // 20% headroom
	}

	// Try to read cost budget from policy-limits.json
	costBudget := 25.0 // Default
	policyPath := filepath.Join(os.Getenv("HOME"), ".claude", "policy-limits.json")
	if data, err := os.ReadFile(policyPath); err == nil {
		var limits struct {
			CostBudget float64 `json:"cost_budget"`
		}
		if err := json.Unmarshal(data, &limits); err == nil && limits.CostBudget > 0 {
			costBudget = limits.CostBudget
		}
	}

	result.Resources = ResourceSnapshot{
		ActiveAgents:  active,
		MaxAgents:     maxAgents,
		MemoryMB:      estimatedMemory,
		MaxMemoryMB:   maxMemoryMB,
		Worktrees:     len(result.Worktrees),
		MaxWorktrees:  15,
		EstimatedCost: totalCost,
		CostBudget:    costBudget,
	}

	// Poll IPC logs
	result.IPCEvents = pollIPCLogs()

	return result
}

func pollWorktrees() []WorktreeInfo {
	out, err := exec.Command("git", "worktree", "list", "--porcelain").Output()
	if err != nil {
		return nil
	}

	var trees []WorktreeInfo
	var current WorktreeInfo

	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			if current.Path != "" {
				trees = append(trees, current)
				current = WorktreeInfo{}
			}
			continue
		}
		if strings.HasPrefix(line, "worktree ") {
			current.Path = strings.TrimPrefix(line, "worktree ")
		} else if strings.HasPrefix(line, "branch ") {
			current.Branch = strings.TrimPrefix(line, "branch ")
		} else if line == "bare" {
			current.Bare = true
		}
	}
	if current.Path != "" {
		trees = append(trees, current)
	}

	return trees
}

func pollResultFiles() ([]Agent, int) {
	matches, err := filepath.Glob("/tmp/*.json")
	if err != nil {
		return nil, 0
	}

	var agents []Agent
	parseErrors := 0 // Bug K fix: Track parse failures
	for _, path := range matches {
		// FIX H4: Early checks before reading full file
		basename := filepath.Base(path)

		// Skip non-agent files by name pattern
		if strings.Contains(basename, "swarm") || strings.Contains(basename, "config") {
			continue
		}

		// Skip non-.json files
		if !strings.HasSuffix(basename, ".json") {
			continue
		}

		// Check file size before reading
		info, err := os.Stat(path)
		if err != nil || info.Size() > 1024*1024 {
			continue
		}

		// Peek at first byte to check if it's a JSON array (skip IPC event files)
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		firstByte := make([]byte, 1)
		n, _ := file.Read(firstByte)
		file.Close()
		if n > 0 && firstByte[0] == '[' {
			continue
		}

		// Now read the full file
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}

		var result struct {
			Status     string  `json:"status"`
			Model      string  `json:"model"`
			DurationMs int     `json:"duration_ms"`
			LatencyMs  int     `json:"latencyMs"` // for verify-result.json
			ExitCode   int     `json:"exit_code"`
			Task       string  `json:"task"`
			Output     string  `json:"output"`
			Cost       float64 `json:"cost"`
			Truncated  bool    `json:"truncated"`
			Telemetry  struct {
				TokensIn  int    `json:"tokens_in"`
				TokensOut int    `json:"tokens_out"`
				Effort    string `json:"effort"`
				Scope     string `json:"scope"`
				Prefill   bool   `json:"prefill"`
				ToolCalls struct {
					Total int `json:"total"`
					Read  int `json:"Read"`
					Write int `json:"Write"`
					Edit  int `json:"Edit"`
					Bash  int `json:"Bash"`
					Grep  int `json:"Grep"`
					Glob  int `json:"Glob"`
				} `json:"tool_calls"`
				QualitySignals struct {
					AIAnalysis struct {
						Issue    string `json:"issue"`
						Severity string `json:"severity"`
					} `json:"ai_analysis"`
				} `json:"quality_signals"`
				CompletionChecklist struct {
					Pass int `json:"pass"`
					Fail int `json:"fail"`
					Skip int `json:"skip"`
				} `json:"completion_checklist"`
			} `json:"telemetry"`
		}

		if err := json.Unmarshal(data, &result); err != nil {
			parseErrors++ // Bug K fix: Count parse failures
			log.Printf("[poller] parse error in %s: %v (first 200 bytes: %s)", path, err, truncateStr(string(data), 200))
			continue
		}

		// Only include files that look like agent results
		if result.Status == "" && result.Model == "" {
			continue
		}

		name := filepath.Base(path)
		name = strings.TrimSuffix(name, ".json")

		// Detect role from filename
		role := "worker"
		if strings.Contains(basename, "verify") {
			role = "verifier"
		} else if strings.Contains(basename, "scout") {
			role = "scout"
		}

		status := "done"
		if result.Status == "failed" || result.ExitCode != 0 {
			status = "failed"
		} else if result.Status == "timeout" {
			status = "timeout"
		} else if result.Status == "completed" {
			status = "done"
		}

		// Get file mtime for spawn time approximation
		fileInfo, _ := os.Stat(path)
		var spawnTime, endTime time.Time
		if fileInfo != nil {
			endTime = fileInfo.ModTime()
			// Approximate spawn time from duration (handle both field names)
			durationMs := result.DurationMs
			if durationMs == 0 {
				durationMs = result.LatencyMs
			}
			if durationMs > 0 {
				spawnTime = endTime.Add(-time.Duration(durationMs) * time.Millisecond)
			}
		}

		// Build tool breakdown map
		toolBreakdown := make(map[string]int)
		if result.Telemetry.ToolCalls.Read > 0 {
			toolBreakdown["Read"] = result.Telemetry.ToolCalls.Read
		}
		if result.Telemetry.ToolCalls.Write > 0 {
			toolBreakdown["Write"] = result.Telemetry.ToolCalls.Write
		}
		if result.Telemetry.ToolCalls.Edit > 0 {
			toolBreakdown["Edit"] = result.Telemetry.ToolCalls.Edit
		}
		if result.Telemetry.ToolCalls.Bash > 0 {
			toolBreakdown["Bash"] = result.Telemetry.ToolCalls.Bash
		}
		if result.Telemetry.ToolCalls.Grep > 0 {
			toolBreakdown["Grep"] = result.Telemetry.ToolCalls.Grep
		}
		if result.Telemetry.ToolCalls.Glob > 0 {
			toolBreakdown["Glob"] = result.Telemetry.ToolCalls.Glob
		}

		agents = append(agents, Agent{
			ID:              name,
			Name:            name,
			Model:           result.Model,
			Status:          status,
			Role:            role,
			ToolCalls:       result.Telemetry.ToolCalls.Total,
			ToolBreakdown:   toolBreakdown,
			TokensIn:        result.Telemetry.TokensIn,
			TokensOut:       result.Telemetry.TokensOut,
			Cost:            result.Cost,
			TaskDesc:        result.Task,
			Output:          truncateStr(result.Output, 1000),
			SpawnTime:       spawnTime,
			EndTime:         endTime,
			QualityIssue:    result.Telemetry.QualitySignals.AIAnalysis.Issue,
			QualitySeverity: result.Telemetry.QualitySignals.AIAnalysis.Severity,
			ChecklistPass:   result.Telemetry.CompletionChecklist.Pass,
			ChecklistFail:   result.Telemetry.CompletionChecklist.Fail,
			ChecklistSkip:   result.Telemetry.CompletionChecklist.Skip,
			Effort:          result.Telemetry.Effort,
			Scope:           result.Telemetry.Scope,
			Prefill:         result.Telemetry.Prefill,
			Truncated:       result.Truncated,
			DisallowedTools: roleDisallowedTools(role),
		})
	}

	return agents, parseErrors
}

func pollProcesses() []Agent {
	out, err := exec.Command("ps", "aux").Output()
	if err != nil {
		return nil
	}

	var agents []Agent
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "claude") || strings.Contains(line, "orch-tui") {
			continue
		}
		if strings.Contains(line, "grep") || strings.Contains(line, "ps aux") {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 11 {
			continue
		}

		pid, _ := strconv.Atoi(fields[1])
		if pid == 0 {
			continue
		}

		agents = append(agents, Agent{
			ID:     fmt.Sprintf("proc-%d", pid),
			Name:   fmt.Sprintf("claude-pid-%d", pid),
			Status: "running",
		})
	}

	return agents
}

func pollSwarmDirs() ([]Agent, int) {
	base := "/tmp/swarm"
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, 0
	}

	// FIX C7: Sort by ModTime DESCENDING to keep the 10 most recent directories
	if len(entries) > 10 {
		// Get FileInfo for all entries to access ModTime
		type entryWithTime struct {
			entry   os.DirEntry
			modTime time.Time
		}
		entriesWithTime := make([]entryWithTime, 0, len(entries))
		for _, e := range entries {
			info, err := e.Info()
			if err != nil {
				continue
			}
			entriesWithTime = append(entriesWithTime, entryWithTime{entry: e, modTime: info.ModTime()})
		}
		// Sort by ModTime descending
		sort.Slice(entriesWithTime, func(i, j int) bool {
			return entriesWithTime[i].modTime.After(entriesWithTime[j].modTime)
		})
		// Keep only the 10 most recent
		entriesWithTime = entriesWithTime[:10]
		// Extract back to entries slice
		entries = make([]os.DirEntry, len(entriesWithTime))
		for i, ewt := range entriesWithTime {
			entries[i] = ewt.entry
		}
	}

	var agents []Agent
	parseErrors := 0 // Bug K fix: Track parse failures
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		runDir := filepath.Join(base, entry.Name())
		runID := entry.Name()
		files, err := os.ReadDir(runDir)
		if err != nil {
			continue
		}

		for _, f := range files {
			if !strings.HasSuffix(f.Name(), "-result.json") {
				continue
			}

			agentID := strings.TrimSuffix(f.Name(), "-result.json")
			resultPath := filepath.Join(runDir, f.Name())
			data, err := os.ReadFile(resultPath)
			if err != nil {
				continue
			}

			// Skip JSON arrays (IPC event files, not result files)
			trimmed := bytes.TrimSpace(data)
			if len(trimmed) > 0 && trimmed[0] == byte('[') {
				continue
			}

			var result struct {
				Status     string  `json:"status"`
				Model      string  `json:"model"`
				DurationMs int     `json:"duration_ms"`
				LatencyMs  int     `json:"latencyMs"` // for verify-result.json
				ExitCode   int     `json:"exit_code"`
				Task       string  `json:"task"`
				Output     string  `json:"output"`
				Cost       float64 `json:"cost"`
				Truncated  bool    `json:"truncated"`
				Telemetry  struct {
					TokensIn  int    `json:"tokens_in"`
					TokensOut int    `json:"tokens_out"`
					Effort    string `json:"effort"`
					Scope     string `json:"scope"`
					Prefill   bool   `json:"prefill"`
					ToolCalls struct {
						Total int `json:"total"`
						Read  int `json:"Read"`
						Write int `json:"Write"`
						Edit  int `json:"Edit"`
						Bash  int `json:"Bash"`
						Grep  int `json:"Grep"`
						Glob  int `json:"Glob"`
					} `json:"tool_calls"`
					QualitySignals struct {
						AIAnalysis struct {
							Issue    string `json:"issue"`
							Severity string `json:"severity"`
						} `json:"ai_analysis"`
					} `json:"quality_signals"`
					CompletionChecklist struct {
						Pass int `json:"pass"`
						Fail int `json:"fail"`
						Skip int `json:"skip"`
					} `json:"completion_checklist"`
				} `json:"telemetry"`
			}
			if err := json.Unmarshal(data, &result); err != nil {
				parseErrors++ // Bug K fix: Count parse failures
				log.Printf("[poller] parse error in %s: %v (first 200 bytes: %s)", resultPath, err, truncateStr(string(data), 200))
				continue
			}

			// Detect role from filename
			role := "worker"
			if strings.Contains(f.Name(), "verify") {
				role = "verifier"
			} else if strings.Contains(f.Name(), "scout") {
				role = "scout"
			}

			status := "done"
			if result.Status == "failed" || result.ExitCode != 0 {
				status = "failed"
			} else if result.Status == "timeout" {
				status = "timeout"
			} else if result.Status == "completed" {
				status = "done"
			}

			// Get file mtime for timing
			fileInfo, _ := os.Stat(resultPath)
			var spawnTime, endTime time.Time
			if fileInfo != nil {
				endTime = fileInfo.ModTime()
				durationMs := result.DurationMs
				if durationMs == 0 {
					durationMs = result.LatencyMs
				}
				if durationMs > 0 {
					spawnTime = endTime.Add(-time.Duration(durationMs) * time.Millisecond)
				}
			}

			// Build tool breakdown map
			toolBreakdown := make(map[string]int)
			if result.Telemetry.ToolCalls.Read > 0 {
				toolBreakdown["Read"] = result.Telemetry.ToolCalls.Read
			}
			if result.Telemetry.ToolCalls.Write > 0 {
				toolBreakdown["Write"] = result.Telemetry.ToolCalls.Write
			}
			if result.Telemetry.ToolCalls.Edit > 0 {
				toolBreakdown["Edit"] = result.Telemetry.ToolCalls.Edit
			}
			if result.Telemetry.ToolCalls.Bash > 0 {
				toolBreakdown["Bash"] = result.Telemetry.ToolCalls.Bash
			}
			if result.Telemetry.ToolCalls.Grep > 0 {
				toolBreakdown["Grep"] = result.Telemetry.ToolCalls.Grep
			}
			if result.Telemetry.ToolCalls.Glob > 0 {
				toolBreakdown["Glob"] = result.Telemetry.ToolCalls.Glob
			}

			agents = append(agents, Agent{
				ID:              agentID,
				Name:            agentID,
				Model:           result.Model,
				Status:          status,
				Role:            role,
				RunDir:          runID,
				ToolCalls:       result.Telemetry.ToolCalls.Total,
				ToolBreakdown:   toolBreakdown,
				TokensIn:        result.Telemetry.TokensIn,
				TokensOut:       result.Telemetry.TokensOut,
				Cost:            result.Cost,
				TaskDesc:        result.Task,
				Output:          truncateStr(result.Output, 1000),
				SpawnTime:       spawnTime,
				EndTime:         endTime,
				QualityIssue:    result.Telemetry.QualitySignals.AIAnalysis.Issue,
				QualitySeverity: result.Telemetry.QualitySignals.AIAnalysis.Severity,
				ChecklistPass:   result.Telemetry.CompletionChecklist.Pass,
				ChecklistFail:   result.Telemetry.CompletionChecklist.Fail,
				ChecklistSkip:   result.Telemetry.CompletionChecklist.Skip,
				Effort:          result.Telemetry.Effort,
				Scope:           result.Telemetry.Scope,
				Prefill:         result.Telemetry.Prefill,
				Truncated:       result.Truncated,
				DisallowedTools: roleDisallowedTools(role),
			})
		}

		// Check for progress files (running agents)
		for _, f := range files {
			if !strings.HasSuffix(f.Name(), ".progress.json") {
				continue
			}

			agentID := strings.TrimSuffix(f.Name(), ".progress.json")
			progressPath := filepath.Join(runDir, f.Name())
			data, err := os.ReadFile(progressPath)
			if err != nil {
				continue
			}

			// Skip JSON arrays (IPC event files, not progress files)
			trimmed := bytes.TrimSpace(data)
			if len(trimmed) > 0 && trimmed[0] == byte('[') {
				continue
			}

			var progress struct {
				ToolCalls   int    `json:"tool_calls"`
				ElapsedMs   int    `json:"elapsed_ms"`
				StdoutBytes int    `json:"stdout_bytes"`
				LastTool    string `json:"last_tool"`
				Model       string `json:"model"`
				Task        string `json:"task"`
			}
			if err := json.Unmarshal(data, &progress); err != nil {
				parseErrors++ // Bug K fix: Count parse failures
				log.Printf("[poller] parse error in %s: %v (first 200 bytes: %s)", progressPath, err, truncateStr(string(data), 200))
				continue
			}

			// Get file mtime for spawn time
			fileInfo, _ := os.Stat(progressPath)
			var spawnTime time.Time
			if fileInfo != nil && progress.ElapsedMs > 0 {
				spawnTime = time.Now().Add(-time.Duration(progress.ElapsedMs) * time.Millisecond)
			}

			// Detect role
			role := "worker"
			if strings.Contains(f.Name(), "verify") {
				role = "verifier"
			} else if strings.Contains(f.Name(), "scout") {
				role = "scout"
			}

			agents = append(agents, Agent{
				ID:              agentID,
				Name:            agentID,
				Model:           progress.Model,
				Status:          "running",
				Role:            role,
				RunDir:          runID,
				ToolCalls:       progress.ToolCalls,
				TaskDesc:        progress.Task,
				SpawnTime:       spawnTime,
				LastTool:        progress.LastTool,
				StdoutBytes:     progress.StdoutBytes,
				DisallowedTools: roleDisallowedTools(role),
			})
		}
	}

	return agents, parseErrors
}

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

// roleDisallowedTools returns the disallowed tools for a given role
func roleDisallowedTools(role string) string {
	switch role {
	case "verifier":
		return "Write Edit NotebookEdit Agent"
	case "decomposer":
		return "Write Edit Bash NotebookEdit Agent"
	default:
		return ""
	}
}

// parseIPCJsonl parses an ipc.jsonl file and returns IPC events.
// FIX H20: Use streaming with bufio.Scanner instead of reading entire file into memory
// FIX H5: Limit events per file to reduce sorting overhead (part 1)
func parseIPCJsonl(path string) []IPCEvent {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()

	const maxEventsPerFile = 100 // Limit events per file to reduce sorting load
	var events []IPCEvent
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var ev IPCEvent
		if json.Unmarshal([]byte(line), &ev) == nil {
			// Normalize MCP-schema events: fill From/To/Content from AgentId/Step
			if ev.From == "" && ev.AgentId != "" {
				ev.From = ev.AgentId
			}
			if ev.To == "" {
				ev.To = "orchestrator"
			}
			if ev.Content == "" && ev.Step != "" {
				ev.Content = fmt.Sprintf("%d%% — %s", ev.Percent, ev.Step)
			}
			events = append(events, ev)
		}
	}

	// Keep only the most recent events from this file (jsonl is append-only, so last entries are newest)
	if len(events) > maxEventsPerFile {
		events = events[len(events)-maxEventsPerFile:]
	}

	return events
}

// pollIPCLogsFromDir scans a base directory for subdirectories and collects IPC events from ipc.jsonl files.
// FIX H5: Only scan recent directories to reduce sorting overhead (part 2)
func pollIPCLogsFromDir(base string) []IPCEvent {
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil
	}

	// Only scan the 10 most recent run directories to limit I/O and sorting overhead
	if len(entries) > 10 {
		type entryWithTime struct {
			entry   os.DirEntry
			modTime time.Time
		}
		entriesWithTime := make([]entryWithTime, 0, len(entries))
		for _, e := range entries {
			info, err := e.Info()
			if err != nil {
				continue
			}
			entriesWithTime = append(entriesWithTime, entryWithTime{entry: e, modTime: info.ModTime()})
		}
		// Sort by ModTime descending
		sort.Slice(entriesWithTime, func(i, j int) bool {
			return entriesWithTime[i].modTime.After(entriesWithTime[j].modTime)
		})
		// Keep only the 10 most recent
		entriesWithTime = entriesWithTime[:10]
		// Extract back to entries slice
		entries = make([]os.DirEntry, len(entriesWithTime))
		for i, ewt := range entriesWithTime {
			entries[i] = ewt.entry
		}
	}

	var allEvents []IPCEvent
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		logPath := filepath.Join(base, entry.Name(), "ipc.jsonl")
		if _, err := os.Stat(logPath); err == nil {
			events := parseIPCJsonl(logPath)
			allEvents = append(allEvents, events...)
		}
	}

	return allEvents
}

// pollArborDirs scans /tmp/arbor/ directories and reads meta.json files to build Agent entries.
func pollArborDirs() []Agent {
	base := "/tmp/arbor"
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil
	}

	var agents []Agent
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		metaPath := filepath.Join(base, entry.Name(), "meta.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}

		var meta struct {
			ID        string    `json:"id"`
			Name      string    `json:"name"`
			Model     string    `json:"model"`
			Status    string    `json:"status"`
			Role      string    `json:"role"`
			TaskDesc  string    `json:"task"`
			SpawnTime time.Time `json:"spawn_time"`
			EndTime   time.Time `json:"end_time"`
		}

		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}

		// Build agent from metadata
		agents = append(agents, Agent{
			ID:        meta.ID,
			Name:      meta.Name,
			Model:     meta.Model,
			Status:    meta.Status,
			Role:      meta.Role,
			TaskDesc:  meta.TaskDesc,
			SpawnTime: meta.SpawnTime,
			EndTime:   meta.EndTime,
			RunDir:    entry.Name(),
		})
	}

	return agents
}

// pollIPCLogs reads ipc.jsonl from all swarm and arbor runs, merges, sorts, and caps at 500 events.
func pollIPCLogs() []IPCEvent {
	// Collect from both /tmp/swarm and /tmp/arbor
	swarmEvents := pollIPCLogsFromDir("/tmp/swarm")
	arborEvents := pollIPCLogsFromDir("/tmp/arbor")

	// Merge results
	allEvents := append(swarmEvents, arborEvents...)

	// Sort by timestamp
	sort.Slice(allEvents, func(i, j int) bool {
		return allEvents[i].Timestamp < allEvents[j].Timestamp
	})

	// Cap at 500 events (keep most recent)
	if len(allEvents) > 500 {
		allEvents = allEvents[len(allEvents)-500:]
	}

	return allEvents
}
