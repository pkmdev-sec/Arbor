package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// CostData holds aggregated cost information.
type CostData struct {
	TotalCost      float64
	BudgetLimit    float64
	PerAgent       map[string]float64
	CostHistory    []float64 // last N cost snapshots for sparkline
	BurnRate       float64   // $/minute
	ProjectedTotal float64
	StartTime      time.Time
}

// AggregateCosts builds CostData from agent results and poll data.
func AggregateCosts(agents []Agent, budget float64) CostData {
	data := CostData{
		BudgetLimit: budget,
		PerAgent:    make(map[string]float64),
		CostHistory: []float64{},
		StartTime:   time.Now(),
	}

	// Aggregate costs per agent
	var totalCost float64
	var earliestStart time.Time
	var latestEnd time.Time

	for _, a := range agents {
		totalCost += a.Cost
		if a.ID != "" {
			data.PerAgent[a.ID] = a.Cost
		}

		// Track time range for burn rate calculation
		if !a.SpawnTime.IsZero() {
			if earliestStart.IsZero() || a.SpawnTime.Before(earliestStart) {
				earliestStart = a.SpawnTime
			}
		}
		if !a.EndTime.IsZero() {
			if latestEnd.IsZero() || a.EndTime.After(latestEnd) {
				latestEnd = a.EndTime
			}
		}
	}

	data.TotalCost = totalCost

	// Calculate burn rate
	if !earliestStart.IsZero() {
		endTime := latestEnd
		if endTime.IsZero() {
			endTime = time.Now()
		}
		duration := endTime.Sub(earliestStart)
		if duration > 0 {
			data.BurnRate = totalCost / duration.Minutes()
		}
		data.StartTime = earliestStart
	}

	// Project total cost assuming current burn rate continues
	if data.BurnRate > 0 {
		remainingBudget := budget - totalCost
		if remainingBudget > 0 {
			minutesRemaining := remainingBudget / data.BurnRate
			data.ProjectedTotal = budget
			_ = minutesRemaining // Could be used for time-to-budget-exhaustion
		} else {
			data.ProjectedTotal = totalCost + (data.BurnRate * 10) // Assume 10 more minutes
		}
	} else {
		data.ProjectedTotal = totalCost
	}

	return data
}

// RenderCostDashboard renders the full cost view.
func RenderCostDashboard(data CostData, width int, theme Theme) string {
	var b strings.Builder

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(theme.Accent)
	mutedStyle := lipgloss.NewStyle().Foreground(theme.Muted)

	b.WriteString(headerStyle.Render("  Cost Dashboard"))
	b.WriteString("\n\n")

	// Total cost with progress bar
	pct := (data.TotalCost / data.BudgetLimit) * 100
	if data.BudgetLimit <= 0 {
		pct = 0
	}

	b.WriteString(mutedStyle.Render(fmt.Sprintf("  Total: $%.2f / $%.2f (%.1f%%)", data.TotalCost, data.BudgetLimit, pct)))
	b.WriteString("\n")
	b.WriteString(RenderProgressBar("", data.TotalCost, data.BudgetLimit, width-4, theme))
	b.WriteString("\n\n")

	// Burn rate
	if data.BurnRate > 0 {
		b.WriteString(mutedStyle.Render("  Burn Rate: "))
		b.WriteString(fmt.Sprintf("$%.2f/min", data.BurnRate))
		b.WriteString("\n")
	}

	// Projected total
	if data.ProjectedTotal > 0 && data.ProjectedTotal != data.TotalCost {
		b.WriteString(mutedStyle.Render("  Projected: "))
		projClr := theme.FG
		if data.ProjectedTotal > data.BudgetLimit {
			projClr = theme.Error
		}
		b.WriteString(lipgloss.NewStyle().Foreground(projClr).Render(fmt.Sprintf("$%.2f", data.ProjectedTotal)))
		b.WriteString("\n")
	}

	// Cost history sparkline
	if len(data.CostHistory) > 0 {
		b.WriteString("\n")
		b.WriteString(mutedStyle.Render(fmt.Sprintf("  Cost History (last %d polls)", len(data.CostHistory))))
		b.WriteString("\n")
		sparkWidth := width - 4
		if sparkWidth < 10 {
			sparkWidth = 10
		}
		b.WriteString("  " + RenderSparkline(data.CostHistory, sparkWidth, 1, theme))
		b.WriteString("\n")
	}

	// Per-agent breakdown
	if len(data.PerAgent) > 0 {
		b.WriteString("\n")
		b.WriteString(headerStyle.Render("  Per Agent:"))
		b.WriteString("\n")

		// Sort by cost (highest first)
		type agentCost struct {
			id   string
			cost float64
		}
		var sorted []agentCost
		for id, cost := range data.PerAgent {
			sorted = append(sorted, agentCost{id, cost})
		}
		sort.Slice(sorted, func(i, j int) bool {
			return sorted[i].cost > sorted[j].cost
		})

		// Show top 10 agents
		limit := 10
		if len(sorted) < limit {
			limit = len(sorted)
		}

		for _, ac := range sorted[:limit] {
			agentID := ac.id
			cost := ac.cost

			// Truncate agent ID if needed
			maxID := 12
			if len(agentID) > maxID {
				agentID = agentID[:maxID-3] + "..."
			}

			// Agent cost as percentage of total
			pctOfTotal := 0.0
			if data.TotalCost > 0 {
				pctOfTotal = (cost / data.TotalCost) * 100
			}

			// Progress bar for this agent
			idStyle := lipgloss.NewStyle().Foreground(theme.FG).Width(12)
			costStyle := lipgloss.NewStyle().Foreground(theme.Accent)

			b.WriteString(fmt.Sprintf("  %s  %s  ",
				idStyle.Render(agentID),
				costStyle.Render(fmt.Sprintf("$%.2f", cost)),
			))

			// Mini bar
			barWidth := width - 35
			if barWidth < 10 {
				barWidth = 10
			}
			filled := int(math.Round((cost / data.BudgetLimit) * float64(barWidth)))
			if filled > barWidth {
				filled = barWidth
			}
			if filled < 0 {
				filled = 0
			}
			empty := barWidth - filled

			bar := lipgloss.NewStyle().Foreground(theme.Accent).Render(strings.Repeat("█", filled)) +
				lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Repeat("░", empty))

			b.WriteString(bar)
			b.WriteString(mutedStyle.Render(fmt.Sprintf("  %.0f%%", pctOfTotal)))
			b.WriteString("\n")
		}

		if len(sorted) > limit {
			b.WriteString(mutedStyle.Render(fmt.Sprintf("  ... and %d more agents\n", len(sorted)-limit)))
		}
	}

	return b.String()
}

// RenderSparkline renders a simple sparkline chart using block characters.
func RenderSparkline(data []float64, width, height int, theme Theme) string {
	if len(data) == 0 {
		return lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Repeat("▁", width))
	}

	blocks := []rune{'▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'}

	// Find min/max
	minVal, maxVal := data[0], data[0]
	for _, v := range data {
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
	if len(data) > width {
		start = len(data) - width
	}
	subset := data[start:]

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

// RenderProgressBar renders a horizontal progress bar with percentage.
func RenderProgressBar(label string, current, max float64, width int, theme Theme) string {
	if max <= 0 {
		max = 1
	}
	ratio := current / max
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

	barWidth := width
	if label != "" {
		barWidth = width - len(label) - 2
	}
	if barWidth < 5 {
		barWidth = 5
	}

	filled := int(math.Round(ratio * float64(barWidth)))
	// Bug C11b fix: Clamp filled to prevent negative strings.Repeat
	if filled > barWidth {
		filled = barWidth
	}
	if filled < 0 {
		filled = 0
	}
	empty := barWidth - filled

	bar := lipgloss.NewStyle().Foreground(clr).Render(strings.Repeat("█", filled)) +
		lipgloss.NewStyle().Foreground(theme.Muted).Render(strings.Repeat("░", empty))

	if label != "" {
		labelStyle := lipgloss.NewStyle().Foreground(theme.FG)
		return fmt.Sprintf("  %s %s", labelStyle.Render(label+":"), bar)
	}

	return "  " + bar
}
