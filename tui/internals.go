package main

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// LogEntry represents a structured log entry for the Internals panel.
type LogEntry struct {
	Agent    Agent
	Level    string // "error", "warn", "info", "debug"
	Category string // "quality", "drift", "checklist", "tool", "scope"
	Summary  string
	Detail   string
}

// BuildLogEntries creates structured log entries from agent data.
func BuildLogEntries(agents []Agent) []LogEntry {
	var entries []LogEntry

	for _, a := range agents {
		// Quality signal entries
		if a.QualityIssue != "" {
			level := "warn"
			if a.QualitySeverity == "high" {
				level = "error"
			}
			entries = append(entries, LogEntry{
				Agent:    a,
				Level:    level,
				Category: "quality",
				Summary:  fmt.Sprintf("[%s] %s", a.QualitySeverity, truncSummary(a.QualityIssue, 60)),
				Detail:   a.QualityIssue,
			})
		}

		// Checklist failures
		if a.ChecklistFail > 0 {
			entries = append(entries, LogEntry{
				Agent:    a,
				Level:    "error",
				Category: "checklist",
				Summary:  fmt.Sprintf("✗ %d failed, ✓ %d passed", a.ChecklistFail, a.ChecklistPass),
				Detail:   fmt.Sprintf("Checklist Results:\n  ✓ Pass: %d\n  ✗ Fail: %d\n  ○ Skip: %d", a.ChecklistPass, a.ChecklistFail, a.ChecklistSkip),
			})
		}

		// Zero tool calls (idle drift)
		if a.ToolCalls == 0 && a.Status == "done" && a.ElapsedTime() > 30*time.Second {
			entries = append(entries, LogEntry{
				Agent:    a,
				Level:    "warn",
				Category: "drift",
				Summary:  fmt.Sprintf("0 tool calls in %s — idle drift", FormatElapsed(a.ElapsedTime())),
				Detail:   fmt.Sprintf("Agent ran for %s producing only text output with zero tool calls.\nThis indicates the agent did not interact with the codebase.", FormatElapsed(a.ElapsedTime())),
			})
		}

		// Failed agents
		if a.Status == "failed" {
			entries = append(entries, LogEntry{
				Agent:    a,
				Level:    "error",
				Category: "status",
				Summary:  fmt.Sprintf("Agent failed after %s", FormatElapsed(a.ElapsedTime())),
				Detail:   fmt.Sprintf("Status: failed\nModel: %s\nElapsed: %s\nTask: %s", a.Model, FormatElapsed(a.ElapsedTime()), a.TaskDesc),
			})
		}

		// Scope enforcement
		if a.Scope != "" {
			entries = append(entries, LogEntry{
				Agent:    a,
				Level:    "info",
				Category: "scope",
				Summary:  fmt.Sprintf("Scope: %s", truncSummary(a.Scope, 50)),
				Detail:   fmt.Sprintf("Scope Enforcement:\n  Paths: %s\n  Role: %s\n  Disallowed: %s", a.Scope, a.Role, a.DisallowedTools),
			})
		}

		// Truncated output
		if a.Truncated {
			entries = append(entries, LogEntry{
				Agent:    a,
				Level:    "warn",
				Category: "output",
				Summary:  "Output was truncated (exceeded buffer limit)",
			})
		}
	}

	// Sort: errors first, then warnings, then info
	levelOrder := map[string]int{"error": 0, "warn": 1, "info": 2, "debug": 3}
	sort.Slice(entries, func(i, j int) bool {
		return levelOrder[entries[i].Level] < levelOrder[entries[j].Level]
	})

	return entries
}

func truncSummary(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > max {
		return s[:max-3] + "..."
	}
	return s
}

// RenderInternalsPanel renders a two-pane Internals view with log-style entries.
func RenderInternalsPanel(agents []Agent, ipcEvents []IPCEvent, selected, width, height int, theme Theme) string {
	entries := BuildLogEntries(agents)

	if len(entries) == 0 {
		return lipgloss.NewStyle().Foreground(theme.Muted).Render("  No quality signals, issues, or scope data found")
	}

	// Two-pane layout
	listW := width * 40 / 100
	if listW < 40 {
		listW = 40
	}
	detailW := width - listW - 3

	// Clamp selection
	sel := selected
	if sel >= len(entries) {
		sel = len(entries) - 1
	}
	if sel < 0 {
		sel = 0
	}

	// Build log list (left pane)
	var listLines []string
	visibleH := height - 4
	if visibleH < 5 {
		visibleH = 5
	}

	// Scroll window
	startIdx := sel - visibleH/2
	if startIdx < 0 {
		startIdx = 0
	}
	endIdx := startIdx + visibleH
	if endIdx > len(entries) {
		endIdx = len(entries)
		startIdx = max(0, endIdx-visibleH)
	}

	for i := startIdx; i < endIdx; i++ {
		e := entries[i]
		isSelected := i == sel

		// Level badge (charmbracelet/log style)
		levelBadge := renderLevelBadge(e.Level, theme)

		// Category tag
		catStyle := lipgloss.NewStyle().Foreground(theme.Muted)
		catTag := catStyle.Render(fmt.Sprintf("%-9s", e.Category))

		// Agent name
		nameStyle := lipgloss.NewStyle().Foreground(theme.FG)
		if isSelected {
			nameStyle = nameStyle.Bold(true).Foreground(theme.Accent)
		}
		name := e.Agent.Name
		if name == "" {
			name = e.Agent.ID
		}
		if len(name) > 18 {
			name = name[:15] + "..."
		}

		prefix := "  "
		if isSelected {
			prefix = "► "
		}

		// Summary (truncated to fit)
		summaryMax := listW - 45
		if summaryMax < 10 {
			summaryMax = 10
		}
		summary := e.Summary
		if len(summary) > summaryMax {
			summary = summary[:summaryMax-3] + "..."
		}

		line := fmt.Sprintf("%s%s %s %-18s %s",
			prefix,
			levelBadge,
			catTag,
			nameStyle.Render(name),
			lipgloss.NewStyle().Foreground(theme.Muted).Render(summary),
		)
		listLines = append(listLines, line)
	}

	// Scroll indicators
	if startIdx > 0 {
		listLines = append([]string{
			lipgloss.NewStyle().Foreground(theme.Muted).Render(fmt.Sprintf("  ▲ %d more", startIdx)),
		}, listLines...)
	}
	remaining := len(entries) - endIdx
	if remaining > 0 {
		listLines = append(listLines,
			lipgloss.NewStyle().Foreground(theme.Muted).Render(fmt.Sprintf("  ▼ %d more", remaining)),
		)
	}

	// Footer
	errorCount := 0
	warnCount := 0
	for _, e := range entries {
		if e.Level == "error" {
			errorCount++
		} else if e.Level == "warn" {
			warnCount++
		}
	}
	footer := lipgloss.NewStyle().Foreground(theme.Muted).Render(
		fmt.Sprintf("  %d entries | %d errors | %d warnings | %d/%d",
			len(entries), errorCount, warnCount, sel+1, len(entries)))
	listLines = append(listLines, "", footer)

	list := strings.Join(listLines, "\n")

	// Build detail view (right pane)
	detail := renderLogDetail(entries, sel, detailW, theme)

	listPanel := theme.PanelStyle.Copy().Width(listW).MaxHeight(height).Render(list)
	detailPanel := theme.ActivePanel.Copy().Width(detailW).MaxHeight(height).Render(detail)

	return lipgloss.JoinHorizontal(lipgloss.Top, listPanel, " ", detailPanel)
}

// renderLevelBadge renders a colored level badge like charmbracelet/log.
func renderLevelBadge(level string, theme Theme) string {
	var bg, fg lipgloss.Color
	var label string

	switch level {
	case "error":
		bg = lipgloss.Color("#ff0000")
		fg = lipgloss.Color("#ffffff")
		label = " ERR "
	case "warn":
		bg = lipgloss.Color("#ffaa00")
		fg = lipgloss.Color("#000000")
		label = " WRN "
	case "info":
		bg = lipgloss.Color("#58a6ff")
		fg = lipgloss.Color("#000000")
		label = " INF "
	case "debug":
		bg = lipgloss.Color("#484f58")
		fg = lipgloss.Color("#ffffff")
		label = " DBG "
	default:
		bg = lipgloss.Color("#484f58")
		fg = lipgloss.Color("#ffffff")
		label = " ??? "
	}

	return lipgloss.NewStyle().
		Background(bg).
		Foreground(fg).
		Bold(true).
		Render(label)
}

// renderLogDetail renders the detail view for a selected log entry.
func renderLogDetail(entries []LogEntry, sel, width int, theme Theme) string {
	if sel < 0 || sel >= len(entries) {
		return lipgloss.NewStyle().Foreground(theme.Muted).Render("\n  Select an entry to view details")
	}

	e := entries[sel]
	var b strings.Builder
	muted := lipgloss.NewStyle().Foreground(theme.Muted)
	bold := lipgloss.NewStyle().Bold(true).Foreground(theme.FG)

	// Header with level badge
	b.WriteString(renderLevelBadge(e.Level, theme))
	b.WriteString(" ")
	name := e.Agent.Name
	if name == "" {
		name = e.Agent.ID
	}
	b.WriteString(bold.Render(name))
	b.WriteString("\n\n")

	// Structured key-value pairs (charmbracelet/log style)
	kvStyle := lipgloss.NewStyle().Foreground(theme.Accent)

	b.WriteString(kvStyle.Render("category") + muted.Render("=") + e.Category + "  ")
	b.WriteString(kvStyle.Render("level") + muted.Render("=") + e.Level + "  ")
	b.WriteString(kvStyle.Render("model") + muted.Render("=") + e.Agent.Model)
	b.WriteString("\n")

	b.WriteString(kvStyle.Render("status") + muted.Render("=") + e.Agent.Status + "  ")
	b.WriteString(kvStyle.Render("elapsed") + muted.Render("=") + FormatElapsed(e.Agent.ElapsedTime()) + "  ")
	if e.Agent.ToolCalls > 0 {
		b.WriteString(kvStyle.Render("tools") + muted.Render("=") + fmt.Sprintf("%d", e.Agent.ToolCalls))
	}
	b.WriteString("\n")

	if e.Agent.Role != "" {
		b.WriteString(kvStyle.Render("role") + muted.Render("=") + e.Agent.Role + "  ")
	}
	if e.Agent.Effort != "" {
		b.WriteString(kvStyle.Render("effort") + muted.Render("=") + e.Agent.Effort + "  ")
	}
	if e.Agent.RunDir != "" {
		b.WriteString(kvStyle.Render("run") + muted.Render("=") + e.Agent.RunDir)
	}
	b.WriteString("\n")

	// Separator
	b.WriteString(muted.Render(strings.Repeat("─", min(width-4, 60))))
	b.WriteString("\n\n")

	// Summary
	b.WriteString(bold.Render("Summary"))
	b.WriteString("\n")
	b.WriteString(e.Summary)
	b.WriteString("\n\n")

	// Full detail
	if e.Detail != "" {
		b.WriteString(bold.Render("Detail"))
		b.WriteString("\n")
		// Word-wrap detail to width
		for _, line := range strings.Split(e.Detail, "\n") {
			if width > 4 && len(line) > width-4 {
				line = line[:width-7] + "..."
			}
			b.WriteString(line + "\n")
		}
		b.WriteString("\n")
	}

	// Task description
	if e.Agent.TaskDesc != "" {
		b.WriteString(bold.Render("Task"))
		b.WriteString("\n")
		task := e.Agent.TaskDesc
		if width > 4 && len(task) > width-4 {
			task = task[:width-7] + "..."
		}
		b.WriteString(task)
		b.WriteString("\n\n")
	}

	// Tool breakdown if available
	if e.Agent.ToolBreakdown != nil && len(e.Agent.ToolBreakdown) > 0 {
		b.WriteString(bold.Render("Tool Breakdown"))
		b.WriteString("\n")
		maxVal := 0
		for _, v := range e.Agent.ToolBreakdown {
			if v > maxVal {
				maxVal = v
			}
		}
		barWidth := min(width-25, 30)
		if barWidth < 5 {
			barWidth = 5
		}
		for tool, count := range e.Agent.ToolBreakdown {
			if count == 0 {
				continue
			}
			bar := ""
			if maxVal > 0 {
				filled := count * barWidth / maxVal
				bar = strings.Repeat("█", filled) + strings.Repeat("░", barWidth-filled)
			}
			b.WriteString(fmt.Sprintf("  %-8s %s %d\n",
				tool,
				lipgloss.NewStyle().Foreground(theme.Accent).Render(bar),
				count,
			))
		}
		b.WriteString("\n")
	}

	// Output preview
	if e.Agent.Output != "" {
		b.WriteString(bold.Render("Output Preview"))
		b.WriteString("\n")
		cleaned := strings.ReplaceAll(e.Agent.Output, "**", "")
		cleaned = strings.ReplaceAll(cleaned, "```", "")
		lines := strings.Split(cleaned, "\n")
		maxLines := 15
		if len(lines) > maxLines {
			lines = lines[:maxLines]
		}
		for _, line := range lines {
			if width > 4 && len(line) > width-4 {
				line = line[:width-7] + "..."
			}
			b.WriteString(muted.Render("  " + line) + "\n")
		}
	}

	return b.String()
}
