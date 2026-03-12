package main

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// Agent represents a single agent in the orchestration system.
type Agent struct {
	ID              string
	Name            string
	Model           string // opus, sonnet
	Status          string // spawning, running, done, failed, timeout
	Level           int    // 0, 1, 2
	WorktreePath    string
	SpawnTime       time.Time
	EndTime         time.Time
	TaskDesc        string
	Output          string
	ToolCalls       int
	TokensIn        int
	TokensOut       int
	Cost            float64
	FilesChanged    []FileChange
	IsMain          bool // true for main session
	QualityIssue    string
	QualitySeverity string // high, medium, low
	ChecklistPass   int
	ChecklistFail   int
	ChecklistSkip   int
	ToolBreakdown   map[string]int // per-tool counts: Read:5, Bash:3
	RunDir          string         // which swarm run this belongs to
	Role            string         // worker, verifier, scout

	// Part 1-3 features (RE findings)
	Effort         string  // low, medium, high, max — thinking depth
	Scope          string  // comma-separated scope paths for enforcement
	Prefill        bool    // whether --prefill was used for warm-starting
	FallbackModel  string  // auto-fallback model on overload
	SessionID      string  // session UUID for resume tracking
	RetryCount     int     // number of retries attempted
	PersistContext bool    // context written to CLAUDE.md for compaction survival

	// RE-discovered internal signals
	DisallowedTools string  // tools blocked for this role (denylist)
	LastTool        string  // last tool call observed
	StdoutBytes     int     // output size in bytes
	Truncated       bool    // output was truncated by ring buffer
}

// FileChange tracks a single file modification by an agent.
type FileChange struct {
	Path   string
	Action string // added, modified, deleted
}

// ElapsedTime returns the duration since spawn or total run time.
func (a Agent) ElapsedTime() time.Duration {
	if a.Status == "done" || a.Status == "failed" || a.Status == "timeout" {
		if !a.EndTime.IsZero() {
			return a.EndTime.Sub(a.SpawnTime)
		}
	}
	if a.SpawnTime.IsZero() {
		return 0
	}
	return time.Since(a.SpawnTime)
}

// FormatElapsed returns a human-readable elapsed time string.
func FormatElapsed(d time.Duration) string {
	if d < time.Second {
		return "0s"
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm%ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%dm", int(d.Hours()), int(d.Minutes())%60)
}

// RenderAgentCard renders a compact agent card for the sidebar list.
func RenderAgentCard(a Agent, selected bool, width int, theme Theme) string {
	statusIcon := theme.StatusIcon(a.Status)
	statusClr := theme.StatusColor(a.Status)

	// Use spinner for running agents (cycles through frames)
	if a.Status == "running" {
		spinners := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
		// Use elapsed time to cycle through spinner frames
		elapsed := a.ElapsedTime()
		frame := int(elapsed.Seconds()) % len(spinners)
		statusIcon = spinners[frame]
	}

	iconStyle := lipgloss.NewStyle().Foreground(statusClr)
	nameStyle := lipgloss.NewStyle().Foreground(theme.FG)
	var bgColor lipgloss.TerminalColor
	hasBackground := false
	if selected {
		nameStyle = nameStyle.Bold(true).Foreground(theme.Accent)
		// Subtle background highlight for selected card
		bgColor = lipgloss.AdaptiveColor{Light: "#e8f0fe", Dark: "#1a1f2e"}
		hasBackground = true
	}

	modelBadge := ""
	if a.Model != "" {
		modelBadge = lipgloss.NewStyle().
			Foreground(theme.Accent).
			Render(fmt.Sprintf("[%s]", a.Model))
	}

	elapsed := FormatElapsed(a.ElapsedTime())
	timeStr := lipgloss.NewStyle().Foreground(theme.Muted).Render(elapsed)

	// Add tool call indicator if > 0
	toolStr := ""
	if a.ToolCalls > 0 {
		toolStr = lipgloss.NewStyle().Foreground(theme.Muted).Render(fmt.Sprintf("t:%d", a.ToolCalls))
	}

	prefix := "  "
	if selected {
		prefix = "► "
	}
	if a.IsMain {
		prefix = "★ "
	}

	name := a.Name
	if name == "" {
		name = a.ID
	}

	// Two-line card format for richer display
	line1 := fmt.Sprintf("%s%s %s %s %s %s",
		prefix,
		iconStyle.Render(statusIcon),
		nameStyle.Render(name),
		modelBadge,
		timeStr,
		toolStr,
	)

	// Second line: task description (truncated)
	line2 := ""
	if a.TaskDesc != "" && len(a.TaskDesc) > 0 {
		snippet := a.TaskDesc
		maxSnippet := width - 4
		if maxSnippet < 20 {
			maxSnippet = 20
		}
		if len(snippet) > maxSnippet {
			snippet = snippet[:maxSnippet-3] + "..."
		}
		line2 = lipgloss.NewStyle().Foreground(theme.Muted).Render(fmt.Sprintf("  %s", snippet))
	}

	combined := line1
	if line2 != "" {
		combined = line1 + "\n" + line2
	}

	// Apply background and left border for visual hierarchy
	// Thicker left border (3 chars) for better visual emphasis
	leftBorder := lipgloss.NewStyle().
		Foreground(statusClr).
		Render("▎ ")

	cardStyle := lipgloss.NewStyle().
		PaddingLeft(0)
	if hasBackground {
		cardStyle = cardStyle.Background(bgColor)
	}

	if width > 0 {
		cardStyle = cardStyle.Width(width - 2) // account for border
	}

	return leftBorder + cardStyle.Render(combined)
}

// RenderAgentDetail renders an expanded detail view for the selected agent.
func RenderAgentDetail(a Agent, width int, theme Theme) string {
	if width < 20 {
		width = 20
	}
	var b strings.Builder

	// Header
	statusClr := theme.StatusColor(a.Status)
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(statusClr)
	name := a.Name
	if name == "" {
		name = a.ID
	}

	b.WriteString(headerStyle.Render(fmt.Sprintf("%s %s", theme.StatusIcon(a.Status), name)))
	b.WriteString("\n")

	mutedStyle := lipgloss.NewStyle().Foreground(theme.Muted)

	// Info section
	divider := theme.Divider.Render(strings.Repeat("─", width-2))

	b.WriteString("\n")
	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(theme.Accent).Render("Info"))
	b.WriteString("\n")
	b.WriteString(divider)
	b.WriteString("\n")

	if a.Model != "" {
		b.WriteString(mutedStyle.Render("Model:     "))
		b.WriteString(theme.Badge(a.Model))
		b.WriteString("\n")
	}
	if a.Status != "" {
		b.WriteString(mutedStyle.Render("Status:    "))
		b.WriteString(lipgloss.NewStyle().Foreground(statusClr).Render(a.Status))

		// Mini progress bar for running agents
		if a.Status == "running" && !a.SpawnTime.IsZero() {
			elapsed := a.ElapsedTime().Seconds()
			maxTime := 600.0 // 10 minutes
			ratio := elapsed / maxTime
			if ratio > 1 {
				ratio = 1
			}
			barWidth := 20
			filled := int(ratio * float64(barWidth))
			empty := barWidth - filled
			bar := lipgloss.NewStyle().Foreground(theme.Success).Render(strings.Repeat("█", filled)) +
				lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Repeat("░", empty))
			b.WriteString(fmt.Sprintf("  %s", bar))
		}
		b.WriteString("\n")
	}
	b.WriteString(mutedStyle.Render("Level:     "))
	b.WriteString(fmt.Sprintf("%d", a.Level))
	b.WriteString("\n")

	b.WriteString(mutedStyle.Render("Elapsed:   "))
	b.WriteString(FormatElapsed(a.ElapsedTime()))
	b.WriteString("\n")

	if a.WorktreePath != "" {
		b.WriteString(mutedStyle.Render("Worktree:  "))
		b.WriteString(a.WorktreePath)
		b.WriteString("\n")
	}

	if a.ToolCalls > 0 {
		b.WriteString(mutedStyle.Render("Tools:     "))
		b.WriteString(fmt.Sprintf("%d calls", a.ToolCalls))
		b.WriteString("\n")
	}

	if a.TokensIn > 0 || a.TokensOut > 0 {
		b.WriteString(mutedStyle.Render("Tokens:    "))
		b.WriteString(fmt.Sprintf("%s in / %s out", formatCompact(a.TokensIn), formatCompact(a.TokensOut)))
		b.WriteString("\n")
	}

	if a.Cost > 0 {
		b.WriteString(mutedStyle.Render("Cost:      "))
		b.WriteString(fmt.Sprintf("$%.2f", a.Cost))
		b.WriteString("\n")
	}

	if a.TaskDesc != "" {
		b.WriteString(mutedStyle.Render("Task:      "))
		task := a.TaskDesc
		maxTask := width - 11
		if maxTask > 0 && len(task) > maxTask {
			task = task[:maxTask-3] + "..."
		}
		b.WriteString(task)
		b.WriteString("\n")
	}

	// Run context (role, run dir)
	if a.Role != "" || a.RunDir != "" {
		b.WriteString("\n")
		b.WriteString(mutedStyle.Render("Run Context:"))
		b.WriteString("\n")
		if a.Role != "" {
			b.WriteString(mutedStyle.Render("  Role:   "))
			b.WriteString(a.Role)
			b.WriteString("\n")
		}
		if a.RunDir != "" {
			b.WriteString(mutedStyle.Render("  Run ID: "))
			b.WriteString(a.RunDir)
			b.WriteString("\n")
		}
	}

	// Execution Config (Part 1-3 features)
	if a.Effort != "" || a.Scope != "" || a.Prefill || a.RetryCount > 0 {
		b.WriteString("\n")
		b.WriteString(mutedStyle.Render("Execution Config:"))
		b.WriteString("\n")
		if a.Effort != "" {
			effortClr := theme.Muted
			switch a.Effort {
			case "high", "max":
				effortClr = theme.Warning
			case "medium":
				effortClr = theme.Accent
			}
			b.WriteString(mutedStyle.Render("  Effort:  "))
			b.WriteString(lipgloss.NewStyle().Foreground(effortClr).Bold(true).Render(a.Effort))
			b.WriteString("\n")
		}
		if a.Scope != "" {
			b.WriteString(mutedStyle.Render("  Scope:   "))
			scope := a.Scope
			if len(scope) > width-12 {
				scope = scope[:width-15] + "..."
			}
			b.WriteString(scope)
			b.WriteString("\n")
		}
		if a.Prefill {
			b.WriteString(mutedStyle.Render("  Prefill: "))
			b.WriteString(lipgloss.NewStyle().Foreground(theme.Success).Render("✓ warm-started"))
			b.WriteString("\n")
		}
		if a.RetryCount > 0 {
			b.WriteString(mutedStyle.Render("  Retries: "))
			b.WriteString(lipgloss.NewStyle().Foreground(theme.Warning).Render(fmt.Sprintf("%d", a.RetryCount)))
			b.WriteString("\n")
		}
	}

	// Tool Restrictions
	if a.DisallowedTools != "" {
		b.WriteString("\n")
		b.WriteString(mutedStyle.Render("Tool Restrictions:"))
		b.WriteString("\n")
		b.WriteString(mutedStyle.Render("  Blocked: "))
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Error).Render(a.DisallowedTools))
		b.WriteString("\n")
	}

	// Context Health
	if a.StdoutBytes > 0 || a.Truncated || a.LastTool != "" {
		b.WriteString("\n")
		b.WriteString(mutedStyle.Render("Context Health:"))
		b.WriteString("\n")
		if a.LastTool != "" {
			b.WriteString(mutedStyle.Render("  Last Tool: "))
			b.WriteString(a.LastTool)
			b.WriteString("\n")
		}
		if a.StdoutBytes > 0 {
			b.WriteString(mutedStyle.Render("  Output:    "))
			b.WriteString(formatCompact(a.StdoutBytes) + "B")
			b.WriteString("\n")
		}
		if a.Truncated {
			b.WriteString(lipgloss.NewStyle().Foreground(theme.Warning).Render("  ⚠ Output truncated (exceeded ring buffer)"))
			b.WriteString("\n")
		}
	}

	// Quality Assessment
	if a.QualityIssue != "" {
		b.WriteString("\n")
		b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(theme.Accent).Render("Quality"))
		b.WriteString("\n")
		b.WriteString(divider)
		b.WriteString("\n")

		severityClr := theme.Muted
		switch a.QualitySeverity {
		case "high":
			severityClr = theme.Error
		case "medium":
			severityClr = theme.Warning
		case "low":
			severityClr = lipgloss.AdaptiveColor{Light: "#0969da", Dark: "#58a6ff"}
		}

		b.WriteString("  ")
		b.WriteString(lipgloss.NewStyle().Foreground(severityClr).Render(a.QualitySeverity))
		b.WriteString(": ")
		b.WriteString(a.QualityIssue)
		b.WriteString("\n")
	}

	// Checklist Results
	if a.ChecklistPass > 0 || a.ChecklistFail > 0 || a.ChecklistSkip > 0 {
		b.WriteString("\n")
		b.WriteString(mutedStyle.Render("Checklist Results:"))
		b.WriteString("\n")

		if a.ChecklistPass > 0 {
			b.WriteString(lipgloss.NewStyle().Foreground(theme.Success).Render(fmt.Sprintf("  ✓ %d pass", a.ChecklistPass)))
			b.WriteString("  ")
		}
		if a.ChecklistFail > 0 {
			b.WriteString(lipgloss.NewStyle().Foreground(theme.Error).Render(fmt.Sprintf("✗ %d fail", a.ChecklistFail)))
			b.WriteString("  ")
		}
		if a.ChecklistSkip > 0 {
			b.WriteString(lipgloss.NewStyle().Foreground(theme.Muted).Render(fmt.Sprintf("○ %d skip", a.ChecklistSkip)))
		}
		b.WriteString("\n")
	}

	// Tool Breakdown with horizontal bar chart
	if len(a.ToolBreakdown) > 0 {
		b.WriteString("\n")
		b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(theme.Accent).Render("Tool Breakdown"))
		b.WriteString(mutedStyle.Render(fmt.Sprintf(" (%d total)", a.ToolCalls)))
		b.WriteString("\n")
		b.WriteString(divider)
		b.WriteString("\n")

		// Sort tools by count (descending)
		type toolCount struct {
			name  string
			count int
		}
		var tools []toolCount
		for name, count := range a.ToolBreakdown {
			tools = append(tools, toolCount{name, count})
		}
		sort.Slice(tools, func(i, j int) bool {
			return tools[i].count > tools[j].count
		})

		maxCount := tools[0].count
		barWidth := 20
		if width < 50 {
			barWidth = 10
		}

		for _, tc := range tools {
			ratio := float64(tc.count) / float64(maxCount)
			filled := int(ratio * float64(barWidth))
			empty := barWidth - filled

			bar := lipgloss.NewStyle().Foreground(theme.Accent).Render(strings.Repeat("█", filled)) +
				lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Repeat("░", empty))

			b.WriteString(fmt.Sprintf("  %-6s %s %d\n", tc.name, bar, tc.count))
		}
	}

	if len(a.FilesChanged) > 0 {
		b.WriteString("\n")
		b.WriteString(mutedStyle.Render("Files changed:"))
		b.WriteString("\n")
		for _, f := range a.FilesChanged {
			actionClr := theme.Muted
			switch f.Action {
			case "added":
				actionClr = theme.Success
			case "modified":
				actionClr = theme.Warning
			case "deleted":
				actionClr = theme.Error
			}
			b.WriteString(fmt.Sprintf("  %s %s\n",
				lipgloss.NewStyle().Foreground(actionClr).Render(f.Action),
				f.Path,
			))
		}
	}

	// Output — strip markdown markers for clean display
	if a.Output != "" {
		b.WriteString("\n")
		b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(theme.Accent).Render("Output"))
		b.WriteString("\n")
		b.WriteString(divider)
		b.WriteString("\n")
		// Strip markdown formatting and apply subtle background
		cleaned := a.Output
		cleaned = strings.ReplaceAll(cleaned, "**", "")
		cleaned = strings.ReplaceAll(cleaned, "```", "")
		lines := strings.Split(cleaned, "\n")
		maxLines := 20
		if len(lines) > maxLines {
			lines = lines[len(lines)-maxLines:]
		}

		// Apply subtle background to output section
		outputBg := lipgloss.AdaptiveColor{Light: "#f5f5f5", Dark: "#161616"}
		outputStyle := lipgloss.NewStyle().
			Background(outputBg).
			Padding(0, 1).
			Width(width - 4)

		var outputLines []string
		for _, line := range lines {
			if width > 2 && len(line) > width-6 {
				line = line[:width-9] + "..."
			}
			// Render headers with accent color
			if strings.HasPrefix(line, "## ") || strings.HasPrefix(line, "# ") {
				trimmed := strings.TrimLeft(line, "# ")
				line = lipgloss.NewStyle().Bold(true).Foreground(theme.Accent).Render(trimmed)
			} else if strings.HasPrefix(line, "- ") {
				line = lipgloss.NewStyle().Foreground(theme.FG).Render(" • " + line[2:])
			}
			outputLines = append(outputLines, line)
		}
		b.WriteString(outputStyle.Render(strings.Join(outputLines, "\n")))
		b.WriteString("\n")
	}

	// Quick Actions footer
	b.WriteString("\n")
	b.WriteString(lipgloss.NewStyle().
		Foreground(theme.Muted).
		Render("Actions: [p]ause  [r]esume  [x]disconnect"))

	return b.String()
}

func formatCompact(n int) string {
	switch {
	case n >= 1_000_000_000:
		return fmt.Sprintf("%.1fG", float64(n)/1_000_000_000)
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1fK", float64(n)/1_000)
	default:
		return fmt.Sprintf("%d", n)
	}
}

// SortAgents sorts a slice of agents by the given criteria.
func SortAgents(agents []Agent, sortBy string) {
	switch sortBy {
	case "name":
		sort.Slice(agents, func(i, j int) bool {
			ni, nj := agents[i].Name, agents[j].Name
			if ni == "" { ni = agents[i].ID }
			if nj == "" { nj = agents[j].ID }
			return ni < nj
		})
	case "elapsed":
		sort.Slice(agents, func(i, j int) bool {
			return agents[j].ElapsedTime() < agents[i].ElapsedTime()
		})
	case "status":
		statusOrder := map[string]int{"running": 0, "spawning": 1, "done": 2, "failed": 3, "timeout": 4}
		sort.Slice(agents, func(i, j int) bool {
			oi, oj := statusOrder[agents[i].Status], statusOrder[agents[j].Status]
			if _, ok := statusOrder[agents[i].Status]; !ok { oi = 99 }
			if _, ok := statusOrder[agents[j].Status]; !ok { oj = 99 }
			return oi < oj
		})
	case "model":
		sort.Slice(agents, func(i, j int) bool {
			return agents[i].Model < agents[j].Model
		})
	}
}

// GroupAgents groups agents by the specified field and returns a map.
func GroupAgents(agents []Agent, groupBy string) map[string][]Agent {
	groups := make(map[string][]Agent)
	if groupBy == "" {
		groups["all"] = agents
		return groups
	}

	for _, a := range agents {
		var key string
		switch groupBy {
		case "status":
			key = a.Status
		case "model":
			key = a.Model
			if key == "" {
				key = "unknown"
			}
		case "run":
			key = a.RunDir
			if key == "" {
				key = "no-run"
			}
		default:
			key = "other"
		}
		groups[key] = append(groups[key], a)
	}
	return groups
}
