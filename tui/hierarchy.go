package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// TreeNode represents a node in the swarm run hierarchy tree.
type TreeNode struct {
	ID       string
	Level    int
	Name     string
	Status   string
	Children []*TreeNode
	Expanded bool
	Agent    *Agent
	Progress string // e.g. "3/5 done"
	Duration time.Duration
	Model    string
	Role     string // "run", "scout", "decompose", "wave", "worker", "verify"
	TaskDesc string
	Effort   string // effort level for this node
}

// ToggleExpand toggles the expanded state of the node.
func (n *TreeNode) ToggleExpand() {
	n.Expanded = !n.Expanded
}

// FlattenVisible returns all visible nodes in display order.
func (n *TreeNode) FlattenVisible() []*TreeNode {
	result := []*TreeNode{n}
	if n.Expanded {
		for _, child := range n.Children {
			result = append(result, child.FlattenVisible()...)
		}
	}
	return result
}

// SwarmRun represents a parsed swarm execution for hierarchy display.
type SwarmRun struct {
	RunID     string
	RunDir    string
	Task      string
	HasScout  bool
	HasDecomp bool
	HasVerify bool
	Agents    []SwarmAgent
	Subtasks  []SubtaskInfo
	ModTime   time.Time
}

// SwarmAgent is an agent within a swarm run.
type SwarmAgent struct {
	ID         string
	Role       string // "scout", "decompose", "worker", "verify"
	Model      string
	Status     string
	DurationMs int
	Task       string
}

// SubtaskInfo holds decomposition subtask data.
type SubtaskInfo struct {
	Title     string   `json:"title"`
	DependsOn []string `json:"depends_on"`
	Scope     []string `json:"scope"`
	Model     string   `json:"model"`
}

// ScanSwarmRuns reads swarm run directories and returns structured data.
func ScanSwarmRuns() []SwarmRun {
	base := "/tmp/swarm"
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil
	}

	var runs []SwarmRun
	var totalBytesRead int64 // H7: Track aggregate memory usage

	// Scan last 15 runs (most recent)
	dirEntries := []os.DirEntry{}
	for _, e := range entries {
		if e.IsDir() {
			dirEntries = append(dirEntries, e)
		}
	}
	if len(dirEntries) > 15 {
		dirEntries = dirEntries[len(dirEntries)-15:]
	}

	for _, entry := range dirEntries {
		runDir := filepath.Join(base, entry.Name())
		files, err := os.ReadDir(runDir)
		if err != nil {
			continue
		}

		run := SwarmRun{
			RunID:  entry.Name(),
			RunDir: runDir,
		}

		// Get run mtime from directory
		if info, err := entry.Info(); err == nil {
			run.ModTime = info.ModTime()
		}

		for _, f := range files {
			name := f.Name()
			if !strings.HasSuffix(name, ".json") || name == "ipc-latest.json" {
				continue
			}

			path := filepath.Join(runDir, name)
			info, err := os.Stat(path)
			if err != nil || info.Size() > 512*1024 { // Skip files > 512KB
				continue
			}

			// H7: Check aggregate memory limit (256MB)
			if totalBytesRead+info.Size() > 256*1024*1024 {
				fmt.Fprintf(os.Stderr, "Warning: aggregate memory limit (256MB) exceeded, skipping remaining files\n")
				return runs
			}

			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			totalBytesRead += int64(len(data)) // H7: Track bytes read

			var result struct {
				Status     string `json:"status"`
				Model      string `json:"model"`
				DurationMs int    `json:"duration_ms"`
				LatencyMs  int    `json:"latencyMs"`
				ExitCode   int    `json:"exit_code"`
				Task       string `json:"task"`
				Output     string `json:"output"`
			}
			if err := json.Unmarshal(data, &result); err != nil {
				continue
			}

			dur := result.DurationMs
			if dur == 0 {
				dur = result.LatencyMs
			}

			status := "done"
			if result.ExitCode != 0 || result.Status == "failed" {
				status = "failed"
			}

			switch {
			case name == "scout.json":
				run.HasScout = true
				run.Agents = append(run.Agents, SwarmAgent{
					ID: "scout", Role: "scout", Model: result.Model,
					Status: status, DurationMs: dur,
				})
			case name == "decompose.json":
				run.HasDecomp = true
				run.Agents = append(run.Agents, SwarmAgent{
					ID: "decompose", Role: "decompose", Model: result.Model,
					Status: status, DurationMs: dur,
				})
				// Extract subtasks from decompose output
				if result.Output != "" {
					// H6: Enforce 10MB size limit on output
					if len(result.Output) <= 10*1024*1024 {
						if jsonMatch := extractJSONArray(result.Output, 0); jsonMatch != "" {
							var subtasks []SubtaskInfo
							if json.Unmarshal([]byte(jsonMatch), &subtasks) == nil {
								run.Subtasks = subtasks
							}
						}
					}
				}
			case name == "verify-result.json":
				run.HasVerify = true
				run.Agents = append(run.Agents, SwarmAgent{
					ID: "verify", Role: "verify", Model: result.Model,
					Status: status, DurationMs: dur,
				})
			case strings.HasPrefix(name, "agent-") && strings.HasSuffix(name, "-result.json"):
				agentID := strings.TrimSuffix(name, "-result.json")
				if run.Task == "" && result.Task != "" {
					run.Task = result.Task
				}
				run.Agents = append(run.Agents, SwarmAgent{
					ID: agentID, Role: "worker", Model: result.Model,
					Status: status, DurationMs: dur, Task: result.Task,
				})
			}
		}

		if len(run.Agents) > 0 {
			runs = append(runs, run)
		}
	}

	// Sort by ModTime descending (most recent first)
	sort.Slice(runs, func(i, j int) bool {
		return runs[i].ModTime.After(runs[j].ModTime)
	})

	return runs
}

func extractJSONArray(output string, recursionDepth int) string {
	// H6: Max recursion depth of 100
	if recursionDepth > 100 {
		return ""
	}
	start := strings.Index(output, "[")
	if start < 0 {
		return ""
	}
	depth := 0
	for i := start; i < len(output); i++ {
		switch output[i] {
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				return output[start : i+1]
			}
		}
	}
	return ""
}

// BuildHierarchy constructs a tree from swarm run data (not flat agent list).
func BuildHierarchy() *TreeNode {
	runs := ScanSwarmRuns()

	root := &TreeNode{
		ID:       "root",
		Level:    -1,
		Name:     "Swarm Runs",
		Status:   "running",
		Expanded: true,
		Role:     "root",
	}

	if len(runs) == 0 {
		root.Name = "Swarm Runs (none found)"
		return root
	}

	totalDone := 0
	for _, run := range runs {
		// Run node
		taskSnippet := run.Task
		// M1: Use rune conversion to avoid splitting UTF-8 chars
		if len([]rune(taskSnippet)) > 50 {
			runes := []rune(taskSnippet)
			taskSnippet = string(runes[:47]) + "..."
		}

		// C1: Check RunID length before slicing
		runIDShort := run.RunID
		if len(run.RunID) > 8 {
			runIDShort = run.RunID[:8]
		}

		runNode := &TreeNode{
			ID:       run.RunID,
			Level:    0,
			Name:     runIDShort,
			Status:   runStatus(run),
			Expanded: true, // Expand first run, collapse others
			Role:     "run",
			TaskDesc: taskSnippet,
		}

		workerCount := 0
		doneCount := 0

		// Add scout
		for _, a := range run.Agents {
			if a.Role == "scout" {
				runNode.Children = append(runNode.Children, agentToNode(a, 1))
			}
		}

		// Add decompose
		for _, a := range run.Agents {
			if a.Role == "decompose" {
				node := agentToNode(a, 1)
				if len(run.Subtasks) > 0 {
					node.TaskDesc = fmt.Sprintf("→ %d subtasks", len(run.Subtasks))
				}
				runNode.Children = append(runNode.Children, node)
			}
		}

		// Group workers into waves (simplified: all in one wave for now)
		workers := []SwarmAgent{}
		for _, a := range run.Agents {
			if a.Role == "worker" {
				workers = append(workers, a)
				workerCount++
				if a.Status == "done" {
					doneCount++
				}
			}
		}

		if len(workers) > 0 {
			waveNode := &TreeNode{
				ID:       run.RunID + "-wave-1",
				Level:    1,
				Name:     "Workers",
				Status:   waveStatus(workers),
				Expanded: true,
				Role:     "wave",
				Progress: fmt.Sprintf("%d/%d done", doneCount, workerCount),
			}
			for _, w := range workers {
				waveNode.Children = append(waveNode.Children, agentToNode(w, 2))
			}
			runNode.Children = append(runNode.Children, waveNode)
		}

		// Add verify
		for _, a := range run.Agents {
			if a.Role == "verify" {
				runNode.Children = append(runNode.Children, agentToNode(a, 1))
			}
		}

		runNode.Progress = fmt.Sprintf("%d/%d agents done", doneCount, workerCount)
		if runStatus(run) == "done" {
			totalDone++
		}

		root.Children = append(root.Children, runNode)
	}

	// Collapse all runs except the first
	for i, child := range root.Children {
		if i > 0 {
			child.Expanded = false
		}
	}

	root.Progress = fmt.Sprintf("%d runs", len(runs))
	return root
}

func agentToNode(a SwarmAgent, level int) *TreeNode {
	durStr := ""
	if a.DurationMs > 0 {
		durStr = FormatElapsed(time.Duration(a.DurationMs) * time.Millisecond)
	}
	name := a.ID
	if a.Role != "" && a.Role != "worker" {
		name = a.Role
	}
	return &TreeNode{
		ID:       a.ID,
		Level:    level,
		Name:     name,
		Status:   a.Status,
		Model:    a.Model,
		Role:     a.Role,
		TaskDesc: a.Task,
		Duration: time.Duration(a.DurationMs) * time.Millisecond,
		Progress: durStr,
	}
}

func runStatus(run SwarmRun) string {
	allDone := true
	anyFailed := false
	for _, a := range run.Agents {
		if a.Status != "done" {
			allDone = false
		}
		if a.Status == "failed" {
			anyFailed = true
		}
	}
	if anyFailed {
		return "failed"
	}
	if allDone {
		return "done"
	}
	return "running"
}

func waveStatus(workers []SwarmAgent) string {
	allDone := true
	anyFailed := false
	for _, w := range workers {
		if w.Status != "done" {
			allDone = false
		}
		if w.Status == "failed" {
			anyFailed = true
		}
	}
	if anyFailed {
		return "failed"
	}
	if allDone {
		return "done"
	}
	return "running"
}

// RenderHierarchy renders the tree as a string for the viewport.
func RenderHierarchy(root *TreeNode, selectedIdx int, width int, theme Theme) string {
	if root == nil {
		return lipgloss.NewStyle().Foreground(theme.Muted).Render("  No swarm runs found in /tmp/swarm/")
	}

	visible := root.FlattenVisible()
	var b strings.Builder

	for i, node := range visible {
		if node.Level < 0 {
			// Root node
			rootStyle := lipgloss.NewStyle().Bold(true).Foreground(theme.Accent)
			progress := ""
			if node.Progress != "" {
				progress = lipgloss.NewStyle().Foreground(theme.Muted).Render("  " + node.Progress)
			}
			b.WriteString(rootStyle.Render("  "+node.Name) + progress + "\n\n")
			continue
		}

		// Tree connectors with proper drawing characters
		indent := ""
		connector := ""
		for l := 0; l < node.Level; l++ {
			indent += "│  "
		}

		// Determine if this is the last child (simplified: just use ├── for all)
		if node.Level > 0 {
			connector = "├──"
		}

		// Expand/collapse indicator for nodes with children
		expandIcon := ""
		if len(node.Children) > 0 {
			if node.Expanded {
				expandIcon = "▼ "
			} else {
				expandIcon = "► "
			}
		}

		// Status icon
		statusClr := theme.StatusColor(node.Status)
		statusIcon := theme.StatusIcon(node.Status)

		// Color-code by role
		roleColor := theme.FG
		switch node.Role {
		case "scout":
			roleColor = lipgloss.AdaptiveColor{Light: "#0969da", Dark: "#58a6ff"}
		case "decompose":
			roleColor = lipgloss.AdaptiveColor{Light: "#9a6700", Dark: "#d29922"}
		case "worker":
			roleColor = theme.FG
		case "verify":
			roleColor = lipgloss.AdaptiveColor{Light: "#8250df", Dark: "#bc8cff"}
		case "run":
			roleColor = theme.Accent
		case "wave":
			roleColor = theme.Muted
		}

		// Selection highlight
		nameStyle := lipgloss.NewStyle().Foreground(roleColor)
		if i == selectedIdx {
			nameStyle = nameStyle.Bold(true).Foreground(theme.Accent)
		}

		// Model badge
		modelBadge := ""
		if node.Model != "" {
			short := node.Model
			if idx := strings.Index(short, "["); idx > 0 {
				short = short[:idx]
			}
			modelBadge = lipgloss.NewStyle().Foreground(theme.Muted).Render(fmt.Sprintf(" [%s]", short))
		}

		// Effort badge
		effortBadge := ""
		if node.Effort != "" {
			effortClr := theme.Muted
			if node.Effort == "high" || node.Effort == "max" {
				effortClr = theme.Warning
			} else if node.Effort == "medium" {
				effortClr = theme.Accent
			}
			effortBadge = lipgloss.NewStyle().Foreground(effortClr).Render(fmt.Sprintf(" (%s)", node.Effort))
		}

		// Duration/progress with completion bar for wave nodes
		extra := ""
		if node.Progress != "" {
			if node.Role == "wave" {
				// Extract completion fraction from progress string like "3/5 done"
				parts := strings.Fields(node.Progress)
				if len(parts) > 0 {
					fraction := parts[0]
					var done, total int
					if _, err := fmt.Sscanf(fraction, "%d/%d", &done, &total); err == nil && total > 0 {
						ratio := float64(done) / float64(total)
						barWidth := 10
						filled := int(ratio * float64(barWidth))
						empty := barWidth - filled
						bar := lipgloss.NewStyle().Foreground(theme.Success).Render(strings.Repeat("█", filled)) +
							lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Repeat("░", empty))
						extra = fmt.Sprintf("  %s %s", bar, lipgloss.NewStyle().Foreground(theme.Muted).Render(node.Progress))
					} else {
						extra = lipgloss.NewStyle().Foreground(theme.Muted).Render("  " + node.Progress)
					}
				}
			} else {
				extra = lipgloss.NewStyle().Foreground(theme.Muted).Render("  " + node.Progress)
			}
		}

		// Task description for runs and workers
		taskStr := ""
		if node.TaskDesc != "" && (node.Role == "run" || node.Role == "worker" || node.Role == "decompose") {
			snippet := node.TaskDesc
			maxLen := width - lipgloss.Width(indent) - 40
			if maxLen < 20 {
				maxLen = 20
			}
			// M1: Use rune conversion to avoid splitting UTF-8 chars
			if len([]rune(snippet)) > maxLen {
				runes := []rune(snippet)
				snippet = string(runes[:maxLen-3]) + "..."
			}
			taskStr = lipgloss.NewStyle().Foreground(theme.Muted).Render("  " + snippet)
		}

		line := fmt.Sprintf("%s%s%s%s %s%s%s%s%s",
			indent,
			connector,
			expandIcon,
			lipgloss.NewStyle().Foreground(statusClr).Render(statusIcon),
			nameStyle.Render(node.Name),
			modelBadge,
			effortBadge,
			extra,
			taskStr,
		)

		// M1: Use rune conversion to avoid splitting UTF-8 chars
		if width > 0 && lipgloss.Width(line) > width {
			runes := []rune(line)
			if len(runes) > width {
				line = string(runes[:width])
			}
		}

		b.WriteString(line + "\n")
	}

	return b.String()
}
