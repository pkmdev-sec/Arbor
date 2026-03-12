package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// ResourceSnapshot holds current resource utilization metrics.
type ResourceSnapshot struct {
	ActiveAgents  int
	MaxAgents     int
	MemoryMB      float64
	MaxMemoryMB   float64
	Worktrees     int
	MaxWorktrees  int
	EstimatedCost float64
	CostBudget    float64
	MergesActive  int
	MergesTotal   int
	Throughput    float64   // msg/sec
	ThroughputHist []float64 // last 60 samples for sparkline
}

// Gauge renders a progress bar with percentage and color transitions.
func Gauge(label string, value, max float64, width int, theme Theme) string {
	if max <= 0 {
		max = 1
	}
	ratio := value / max
	if ratio > 1 {
		ratio = 1
	}
	if ratio < 0 {
		ratio = 0
	}
	pct := ratio * 100

	// Color transition: green < 60%, yellow 60-80%, red > 80%
	var clr lipgloss.AdaptiveColor
	switch {
	case pct < 60:
		clr = theme.Success
	case pct < 80:
		clr = theme.Warning
	default:
		clr = theme.Error
	}

	barWidth := width - len(label) - 12 // label + space + pct
	// Bug I fix: Clamp to minimum 1 to prevent negative width on narrow terminals
	if barWidth < 1 {
		barWidth = 1
	}

	filled := int(math.Round(ratio * float64(barWidth)))
	empty := barWidth - filled

	bar := lipgloss.NewStyle().Foreground(clr).Render(strings.Repeat("█", filled)) +
		lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Repeat("░", empty))

	labelStyle := lipgloss.NewStyle().Foreground(theme.FG).Width(10)
	pctStr := lipgloss.NewStyle().Foreground(clr).Render(fmt.Sprintf("%3.0f%%", pct))

	return fmt.Sprintf("  %s %s %s", labelStyle.Render(label+":"), bar, pctStr)
}

// Sparkline renders a sparkline from a history of values using block chars.
func Sparkline(values []float64, width int, theme Theme) string {
	if len(values) == 0 {
		return lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Repeat("▁", width))
	}

	blocks := []rune{'▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'}

	// Find min/max
	minVal, maxVal := values[0], values[0]
	for _, v := range values {
		if v < minVal {
			minVal = v
		}
		if v > maxVal {
			maxVal = v
		}
	}
	rng := maxVal - minVal
	if rng == 0 {
		rng = 1
	}

	// Take last `width` values
	start := 0
	if len(values) > width {
		start = len(values) - width
	}
	subset := values[start:]

	var b strings.Builder
	for _, v := range subset {
		idx := int(math.Round(((v - minVal) / rng) * float64(len(blocks)-1)))
		if idx < 0 {
			idx = 0
		}
		if idx >= len(blocks) {
			idx = len(blocks) - 1
		}
		b.WriteRune(blocks[idx])
	}

	// Pad remaining width
	remaining := width - len(subset)
	for i := 0; i < remaining; i++ {
		b.WriteRune(blocks[0])
	}

	return lipgloss.NewStyle().Foreground(theme.Accent).Render(b.String())
}

// RenderResourcePanel renders the full resource dashboard.
func RenderResourcePanel(rs ResourceSnapshot, width int, theme Theme) string {
	var b strings.Builder

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(theme.Accent)
	mutedStyle := lipgloss.NewStyle().Foreground(theme.Muted)

	b.WriteString(headerStyle.Render("  Resource Governor"))
	b.WriteString("\n\n")

	// Agent gauge
	b.WriteString(Gauge("Agents", float64(rs.ActiveAgents), float64(rs.MaxAgents), width, theme))
	b.WriteString(mutedStyle.Render(fmt.Sprintf("  %d/%d", rs.ActiveAgents, rs.MaxAgents)))
	b.WriteString("\n")

	// Memory gauge
	b.WriteString(Gauge("Memory", rs.MemoryMB, rs.MaxMemoryMB, width, theme))
	b.WriteString(mutedStyle.Render(fmt.Sprintf("  %.0fMB/%.0fMB", rs.MemoryMB, rs.MaxMemoryMB)))
	b.WriteString("\n")

	// Worktree gauge
	b.WriteString(Gauge("Worktrees", float64(rs.Worktrees), float64(rs.MaxWorktrees), width, theme))
	b.WriteString(mutedStyle.Render(fmt.Sprintf("  %d/%d", rs.Worktrees, rs.MaxWorktrees)))
	b.WriteString("\n")

	// Cost gauge
	b.WriteString(Gauge("Cost", rs.EstimatedCost, rs.CostBudget, width, theme))
	b.WriteString(mutedStyle.Render(fmt.Sprintf("  $%.2f/$%.2f", rs.EstimatedCost, rs.CostBudget)))
	b.WriteString("\n")

	// Merges
	if rs.MergesTotal > 0 {
		b.WriteString(Gauge("Merges", float64(rs.MergesActive), float64(rs.MergesTotal), width, theme))
		b.WriteString(mutedStyle.Render(fmt.Sprintf("  %d/%d", rs.MergesActive, rs.MergesTotal)))
		b.WriteString("\n")
	}

	// Throughput
	b.WriteString("\n")
	b.WriteString(headerStyle.Render("  Throughput"))
	b.WriteString(mutedStyle.Render(fmt.Sprintf("  %.1f msg/s", rs.Throughput)))
	b.WriteString("\n")

	sparkWidth := width - 4
	if sparkWidth < 10 {
		sparkWidth = 10
	}
	b.WriteString("  " + Sparkline(rs.ThroughputHist, sparkWidth, theme))
	b.WriteString("\n")

	return b.String()
}

// RenderResourcePanelExtended renders the full resource dashboard with extended metrics.
func RenderResourcePanelExtended(rs ResourceSnapshot, agents []Agent, worktrees []WorktreeInfo, width int, theme Theme) string {
	var sections []string

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(theme.Accent)
	mutedStyle := lipgloss.NewStyle().Foreground(theme.Muted)

	// Section 1: Resource Gauges
	var gauges strings.Builder
	gauges.WriteString(headerStyle.Render("Resource Gauges"))
	gauges.WriteString("\n\n")
	gauges.WriteString(Gauge("Agents", float64(rs.ActiveAgents), float64(rs.MaxAgents), width-4, theme))
	gauges.WriteString(mutedStyle.Render(fmt.Sprintf("  %d/%d", rs.ActiveAgents, rs.MaxAgents)))
	gauges.WriteString("\n")
	gauges.WriteString(Gauge("Memory", rs.MemoryMB, rs.MaxMemoryMB, width-4, theme))
	gauges.WriteString(mutedStyle.Render(fmt.Sprintf("  %.0fMB/%.0fMB", rs.MemoryMB, rs.MaxMemoryMB)))
	gauges.WriteString("\n")
	gauges.WriteString(Gauge("Cost", rs.EstimatedCost, rs.CostBudget, width-4, theme))
	gauges.WriteString(mutedStyle.Render(fmt.Sprintf("  $%.2f/$%.2f", rs.EstimatedCost, rs.CostBudget)))

	sections = append(sections, lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(theme.Border).
		Padding(1, 2).
		Width(width).
		Render(gauges.String()))

	// Section 2: Tool Call Distribution
	toolDist := make(map[string]int)
	totalTools := 0
	for _, a := range agents {
		for tool, count := range a.ToolBreakdown {
			toolDist[tool] += count
			totalTools += count
		}
	}

	if totalTools > 0 {
		var toolSection strings.Builder
		toolSection.WriteString(headerStyle.Render(fmt.Sprintf("Tool Distribution (%d total)", totalTools)))
		toolSection.WriteString("\n\n")

		// Sort tools by count
		type toolCount struct {
			name  string
			count int
		}
		var tools []toolCount
		for name, count := range toolDist {
			tools = append(tools, toolCount{name, count})
		}
		sort.Slice(tools, func(i, j int) bool {
			return tools[i].count > tools[j].count
		})

		// Show top 6 tools
		limit := 6
		if len(tools) < limit {
			limit = len(tools)
		}
		for i := 0; i < limit; i++ {
			tc := tools[i]
			pct := float64(tc.count) / float64(totalTools) * 100
			barWidth := 20
			filled := int(pct / 100 * float64(barWidth))
			empty := barWidth - filled

			bar := lipgloss.NewStyle().Foreground(theme.Accent).Render(strings.Repeat("█", filled)) +
				lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Repeat("░", empty))

			toolSection.WriteString(fmt.Sprintf("%-6s %s %3d (%3.0f%%)\n", tc.name, bar, tc.count, pct))
		}

		sections = append(sections, lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(theme.Border).
			Padding(1, 2).
			Width(width).
			Render(toolSection.String()))
	}

	// Section 3: Top 5 Most Expensive Agents
	type agentCost struct {
		name string
		cost float64
	}
	var costList []agentCost
	for _, a := range agents {
		if a.Cost > 0 {
			name := a.Name
			if name == "" {
				name = a.ID
			}
			costList = append(costList, agentCost{name, a.Cost})
		}
	}
	sort.Slice(costList, func(i, j int) bool {
		return costList[i].cost > costList[j].cost
	})

	if len(costList) > 0 {
		var costSection strings.Builder
		costSection.WriteString(headerStyle.Render("Top 5 Most Expensive Agents"))
		costSection.WriteString("\n\n")

		limit := 5
		if len(costList) < limit {
			limit = len(costList)
		}
		for i := 0; i < limit; i++ {
			ac := costList[i]
			name := ac.name
			if len(name) > 20 {
				name = name[:17] + "..."
			}
			costSection.WriteString(fmt.Sprintf("%-20s $%.2f\n", name, ac.cost))
		}

		sections = append(sections, lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(theme.Border).
			Padding(1, 2).
			Width(width).
			Render(costSection.String()))
	}

	// Section 4: Average Completion Time
	var completedAgents []Agent
	var totalDuration float64
	for _, a := range agents {
		if a.Status == "done" || a.Status == "failed" {
			completedAgents = append(completedAgents, a)
			totalDuration += a.ElapsedTime().Seconds()
		}
	}

	if len(completedAgents) > 0 {
		avgDuration := totalDuration / float64(len(completedAgents))
		var statsSection strings.Builder
		statsSection.WriteString(headerStyle.Render("Completion Stats"))
		statsSection.WriteString("\n\n")
		statsSection.WriteString(fmt.Sprintf("Completed:  %d agents\n", len(completedAgents)))
		statsSection.WriteString(fmt.Sprintf("Avg Time:   %s\n", FormatElapsed(time.Duration(avgDuration*float64(time.Second)))))

		sections = append(sections, lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(theme.Border).
			Padding(1, 2).
			Width(width).
			Render(statsSection.String()))
	}

	// Original status breakdown section
	var b strings.Builder

	// Per-status breakdown
	var running, done, failed, spawning, timeout int
	var sonnet, opus int
	for _, a := range agents {
		switch a.Status {
		case "running":
			running++
		case "done":
			done++
		case "failed":
			failed++
		case "spawning":
			spawning++
		case "timeout":
			timeout++
		}
		switch a.Model {
		case "sonnet":
			sonnet++
		case "opus":
			opus++
		}
	}

	b.WriteString(headerStyle.Render("Agent Status"))
	b.WriteString("\n\n")
	if running > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Success).Render(fmt.Sprintf("● Running:  %d", running)))
		b.WriteString("\n")
	}
	if spawning > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Warning).Render(fmt.Sprintf("◔ Spawning: %d", spawning)))
		b.WriteString("\n")
	}
	if done > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Success).Render(fmt.Sprintf("✓ Done:     %d", done)))
		b.WriteString("\n")
	}
	if failed > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Error).Render(fmt.Sprintf("✗ Failed:   %d", failed)))
		b.WriteString("\n")
	}
	if timeout > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Warning).Render(fmt.Sprintf("⏱ Timeout:  %d", timeout)))
		b.WriteString("\n")
	}

	// Model distribution
	if sonnet > 0 || opus > 0 {
		b.WriteString("\n")
		b.WriteString(headerStyle.Render("Model Distribution"))
		b.WriteString("\n")
		if sonnet > 0 {
			b.WriteString(fmt.Sprintf("Sonnet: %d\n", sonnet))
		}
		if opus > 0 {
			b.WriteString(fmt.Sprintf("Opus:   %d\n", opus))
		}
	}

	sections = append(sections, lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(theme.Border).
		Padding(1, 2).
		Width(width).
		Render(b.String()))

	// Active worktrees section
	if len(worktrees) > 0 {
		var wtSection strings.Builder
		wtSection.WriteString(headerStyle.Render(fmt.Sprintf("Active Worktrees (%d)", len(worktrees))))
		wtSection.WriteString("\n\n")
		limit := 5
		if len(worktrees) < limit {
			limit = len(worktrees)
		}
		for i := 0; i < limit; i++ {
			wt := worktrees[i]
			path := wt.Path
			if len(path) > 30 {
				// Trim middle of path
				path = "..." + path[len(path)-27:]
			}
			branch := wt.Branch
			if branch == "" {
				branch = "(detached)"
			}
			wtSection.WriteString(fmt.Sprintf("%s → %s\n", path, branch))
		}
		if len(worktrees) > limit {
			wtSection.WriteString(mutedStyle.Render(fmt.Sprintf("... and %d more", len(worktrees)-limit)))
		}

		sections = append(sections, lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(theme.Border).
			Padding(1, 2).
			Width(width).
			Render(wtSection.String()))
	}

	return lipgloss.JoinVertical(lipgloss.Left, sections...)
}
