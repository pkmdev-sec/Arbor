package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// NetworkEntry represents a single IPC request/event for the network inspector.
type NetworkEntry struct {
	Timestamp time.Time
	TimeStr   string
	From      string
	To        string
	Type      string
	Content   string
	Meta      map[string]interface{}
	Latency   string // from meta.latencyMs
	Tokens    string // from meta.tokens
	Status    string // "ok", "error", "pending"
	Size      int    // content length
}

// BuildNetworkEntries creates network entries from IPC events.
func BuildNetworkEntries(ipcEvents []IPCEvent, agents []Agent) []NetworkEntry {
	var entries []NetworkEntry

	for _, ev := range ipcEvents {
		content := ev.Content
		// Fallback: synthesize content from meta if empty (old-format events)
		if content == "" && ev.Meta != nil {
			if step, ok := ev.Meta["step"]; ok {
				if pct, ok := ev.Meta["percent"]; ok {
					content = fmt.Sprintf("%v%% — %v", pct, step)
				} else {
					content = fmt.Sprintf("%v", step)
				}
			} else if summary, ok := ev.Meta["summary"]; ok {
				content = fmt.Sprintf("%v", summary)
			} else if msg, ok := ev.Meta["message"]; ok {
				content = fmt.Sprintf("%v", msg)
			}
		}

		entry := NetworkEntry{
			Timestamp: time.UnixMilli(ev.Timestamp),
			TimeStr:   time.UnixMilli(ev.Timestamp).Format("15:04:05"),
			From:      ev.From,
			To:        ev.To,
			Type:      ev.Type,
			Content:   content,
			Meta:      ev.Meta,
			Size:      len(content),
			Status:    "ok",
		}

		// Extract latency and tokens from meta
		if ev.Meta != nil {
			if lat, ok := ev.Meta["latencyMs"]; ok {
				if v, ok := lat.(float64); ok {
					entry.Latency = fmt.Sprintf("%dms", int(v))
				}
			}
			if tok, ok := ev.Meta["tokens"]; ok {
				entry.Tokens = fmt.Sprintf("%v", tok)
			}
		}

		// Determine status from type and content
		switch ev.Type {
		case "result":
			if strings.Contains(strings.ToLower(content), "failed") || strings.Contains(content, "exit 1") {
				entry.Status = "error"
			}
		case "verdict":
			if strings.Contains(strings.ToLower(content), "fail") {
				entry.Status = "error"
			}
		case "progress":
			entry.Status = "pending"
		case "log":
			if strings.Contains(strings.ToLower(content), "error") {
				entry.Status = "error"
			}
		}

		entries = append(entries, entry)
	}

	return entries
}

// RenderNetworkPanel renders the Network tab as a two-pane request inspector.
func RenderNetworkPanel(ipcEvents []IPCEvent, agents []Agent, selectedNet int, width, height int, theme Theme) string {
	entries := BuildNetworkEntries(ipcEvents, agents)

	if len(entries) == 0 {
		muted := lipgloss.NewStyle().Foreground(theme.Muted)
		return muted.Render("  No IPC events found. Events are logged in /tmp/swarm/*/ipc.jsonl during swarm runs.")
	}

	// Two-pane layout — clamp to terminal width
	listW := width * 45 / 100
	if listW < 50 {
		listW = 50
	}
	if listW > width-20 {
		listW = width - 20
	}
	if listW < 20 {
		listW = 20
	}
	detailW := width - listW - 3
	if detailW < 15 {
		detailW = 15
	}

	// Clamp selection
	sel := selectedNet
	if sel >= len(entries) {
		sel = len(entries) - 1
	}
	if sel < 0 {
		sel = 0
	}

	// Build request list (left pane) — Chrome DevTools style
	var listLines []string
	muted := lipgloss.NewStyle().Foreground(theme.Muted)
	visibleH := height - 5
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

	// Use fixed-width Lipgloss columns to ensure alignment
	// (fmt.Sprintf %-Ns doesn't work with ANSI-styled strings)
	colTime := lipgloss.NewStyle().Width(9).Foreground(theme.Muted)
	colType := lipgloss.NewStyle().Width(13)
	colFrom := lipgloss.NewStyle().Width(16)
	colTo := lipgloss.NewStyle().Width(16).Foreground(theme.Muted)
	colLat := lipgloss.NewStyle().Width(9).Foreground(theme.Muted)
	colSize := lipgloss.NewStyle().Width(5).Foreground(theme.Muted)

	// Header row
	hdrStyle := lipgloss.NewStyle().Bold(true).Foreground(theme.Accent)
	headerLine := "  " +
		hdrStyle.Copy().Width(3).Render(" ") +
		hdrStyle.Copy().Width(9).Render("Time") +
		hdrStyle.Copy().Width(13).Render("Type") +
		hdrStyle.Copy().Width(16).Render("From") +
		hdrStyle.Copy().Width(2).Render("→") +
		hdrStyle.Copy().Width(16).Render("To") +
		hdrStyle.Copy().Width(9).Render("Latency") +
		hdrStyle.Copy().Width(5).Render("Size")
	listLines = append(listLines, headerLine)
	listLines = append(listLines, muted.Render(strings.Repeat("─", min(listW-2, 90))))

	for i := startIdx; i < endIdx; i++ {
		e := entries[i]
		isSelected := i == sel

		// Status indicator
		statusClr := theme.Muted
		statusIcon := "·"
		switch e.Status {
		case "ok":
			statusClr = theme.Success
			statusIcon = "●"
		case "error":
			statusClr = theme.Error
			statusIcon = "✗"
		case "pending":
			statusClr = theme.Warning
			statusIcon = "◔"
		}

		// Type color
		typeClr := theme.Muted
		switch e.Type {
		case "decision":
			typeClr = theme.Accent
		case "task_assign":
			typeClr = lipgloss.AdaptiveColor{Light: "#3fb950", Dark: "#3fb950"}
		case "result", "verdict":
			typeClr = lipgloss.AdaptiveColor{Light: "#79c0ff", Dark: "#79c0ff"}
		case "lifecycle":
			typeClr = lipgloss.AdaptiveColor{Light: "#d29922", Dark: "#d29922"}
		case "progress":
			typeClr = lipgloss.AdaptiveColor{Light: "#8b949e", Dark: "#8b949e"}
		case "log":
			typeClr = lipgloss.AdaptiveColor{Light: "#bc8cff", Dark: "#bc8cff"}
		}

		prefix := "  "
		if isSelected {
			prefix = "► "
		}

		fromStyle := colFrom.Copy().Foreground(theme.FG)
		if isSelected {
			fromStyle = fromStyle.Bold(true).Foreground(theme.Accent)
		}

		latency := e.Latency
		if latency == "" {
			latency = "—"
		}

		sizeStr := "—"
		if e.Size > 0 {
			if e.Size > 1024 {
				sizeStr = fmt.Sprintf("%dK", e.Size/1024)
			} else {
				sizeStr = fmt.Sprintf("%dB", e.Size)
			}
		}

		from := e.From
		if len(from) > 14 {
			from = from[:11] + "..."
		}
		to := e.To
		if len(to) > 14 {
			to = to[:11] + "..."
		}

		line := prefix +
			lipgloss.NewStyle().Width(3).Foreground(statusClr).Render(statusIcon) +
			colTime.Render(e.TimeStr) +
			colType.Copy().Foreground(typeClr).Render(e.Type) +
			fromStyle.Render(from) +
			lipgloss.NewStyle().Width(2).Foreground(theme.Muted).Render("→") +
			colTo.Render(to) +
			colLat.Render(latency) +
			colSize.Render(sizeStr)

		listLines = append(listLines, line)
	}

	// Scroll indicators
	if startIdx > 0 {
		listLines = append([]string{muted.Render(fmt.Sprintf("  ▲ %d more", startIdx))}, listLines...)
	}
	remaining := len(entries) - endIdx
	if remaining > 0 {
		listLines = append(listLines, muted.Render(fmt.Sprintf("  ▼ %d more", remaining)))
	}

	// Summary footer — count actual event types from coordinator
	progressCount := 0
	resultCount := 0
	lifecycleCount := 0
	errorCount := 0
	for _, e := range entries {
		switch e.Type {
		case "progress":
			progressCount++
		case "result", "verdict":
			resultCount++
		case "lifecycle", "start", "shutdown":
			lifecycleCount++
		}
		if e.Status == "error" {
			errorCount++
		}
	}
	footer := muted.Render(fmt.Sprintf("  %d events | %d progress | %d results | %d lifecycle | %d errors | %d/%d",
		len(entries), progressCount, resultCount, lifecycleCount, errorCount, sel+1, len(entries)))
	listLines = append(listLines, "", footer)

	list := strings.Join(listLines, "\n")

	// Build detail view (right pane) — request inspector
	detail := renderNetworkDetail(entries, sel, detailW, theme)

	listPanel := theme.PanelStyle.Copy().Width(listW).MaxHeight(height).Render(list)
	detailPanel := theme.ActivePanel.Copy().Width(detailW).MaxHeight(height).Render(detail)

	return lipgloss.JoinHorizontal(lipgloss.Top, listPanel, " ", detailPanel)
}

// renderNetworkDetail renders the full detail of a selected network event.
func renderNetworkDetail(entries []NetworkEntry, sel, width int, theme Theme) string {
	if sel < 0 || sel >= len(entries) {
		return lipgloss.NewStyle().Foreground(theme.Muted).Render("\n  Select a request to inspect")
	}

	e := entries[sel]
	var b strings.Builder
	muted := lipgloss.NewStyle().Foreground(theme.Muted)
	bold := lipgloss.NewStyle().Bold(true).Foreground(theme.FG)
	kvKey := lipgloss.NewStyle().Width(14).Foreground(theme.Accent)
	kvVal := lipgloss.NewStyle().Foreground(theme.FG)
	sep := muted.Render(strings.Repeat("─", min(width-4, 60)))

	// Header with type badge
	typeClr := theme.FG
	switch e.Type {
	case "decision":
		typeClr = theme.Accent
	case "task_assign":
		typeClr = lipgloss.AdaptiveColor{Light: "#3fb950", Dark: "#3fb950"}
	case "result", "verdict":
		typeClr = lipgloss.AdaptiveColor{Light: "#79c0ff", Dark: "#79c0ff"}
	case "lifecycle":
		typeClr = lipgloss.AdaptiveColor{Light: "#d29922", Dark: "#d29922"}
	case "progress":
		typeClr = lipgloss.AdaptiveColor{Light: "#8b949e", Dark: "#8b949e"}
	case "log":
		typeClr = lipgloss.AdaptiveColor{Light: "#bc8cff", Dark: "#bc8cff"}
	}

	typeBadge := lipgloss.NewStyle().Bold(true).Padding(0, 1).Foreground(typeClr).Render(strings.ToUpper(e.Type))
	b.WriteString(typeBadge + "  " + muted.Render(e.Timestamp.Format("15:04:05.000")))
	b.WriteString("\n\n")

	// ── General section ──
	b.WriteString(bold.Render("General"))
	b.WriteString("\n")
	b.WriteString(kvKey.Render("Request URL:") + kvVal.Render("ipc://"+e.From+"/"+e.Type) + "\n")
	b.WriteString(kvKey.Render("Method:") + kvVal.Render(e.Type) + "\n")

	// Status with color
	b.WriteString(kvKey.Render("Status:"))
	switch e.Status {
	case "ok":
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Success).Render("200 OK"))
	case "error":
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Error).Render("500 Error"))
	case "pending":
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Warning).Render("102 Processing"))
	}
	b.WriteString("\n")

	b.WriteString(kvKey.Render("Remote:") + kvVal.Render(e.To) + "\n")
	b.WriteString(kvKey.Render("Initiator:") + kvVal.Render(e.From) + "\n")
	b.WriteString(kvKey.Render("Size:") + kvVal.Render(fmt.Sprintf("%d bytes", e.Size)) + "\n")
	b.WriteString(kvKey.Render("Time:") + kvVal.Render(e.Timestamp.Format("2006-01-02T15:04:05.000Z")) + "\n")
	b.WriteString("\n" + sep + "\n\n")

	// ── Timing section ──
	if e.Latency != "" || e.Tokens != "" {
		b.WriteString(bold.Render("Timing"))
		b.WriteString("\n")
		if e.Latency != "" {
			b.WriteString(kvKey.Render("Latency:") + kvVal.Render(e.Latency) + "\n")
			// Visual latency bar
			latMs := 0.0
			if v, ok := e.Meta["latencyMs"]; ok {
				if f, ok := v.(float64); ok {
					latMs = f
				}
			}
			if latMs > 0 {
				barW := min(width-20, 40)
				filled := int(latMs / 60000.0 * float64(barW)) // scale: 60s = full bar
				if filled > barW {
					filled = barW
				}
				if filled < 1 {
					filled = 1
				}
				barClr := theme.Success
				if latMs > 30000 {
					barClr = theme.Error
				} else if latMs > 10000 {
					barClr = theme.Warning
				}
				bar := lipgloss.NewStyle().Foreground(barClr).Render(strings.Repeat("█", filled)) +
					muted.Render(strings.Repeat("░", barW-filled))
				b.WriteString(kvKey.Render("") + bar + " " + fmt.Sprintf("%.1fs", latMs/1000) + "\n")
			}
		}
		if e.Tokens != "" {
			b.WriteString(kvKey.Render("Tokens:") + kvVal.Render(e.Tokens) + "\n")
			// Parse tokens "in+out" format
			parts := strings.Split(e.Tokens, "+")
			if len(parts) == 2 {
				b.WriteString(kvKey.Render("  Input:") + kvVal.Render(strings.TrimSpace(parts[0])) + "\n")
				b.WriteString(kvKey.Render("  Output:") + kvVal.Render(strings.TrimSpace(parts[1])) + "\n")
			}
		}
		b.WriteString("\n" + sep + "\n\n")
	}

	// ── Headers section (all meta as headers) ──
	b.WriteString(bold.Render("Headers"))
	b.WriteString("\n")
	b.WriteString(kvKey.Render("from:") + kvVal.Render(e.From) + "\n")
	b.WriteString(kvKey.Render("to:") + kvVal.Render(e.To) + "\n")
	b.WriteString(kvKey.Render("type:") + kvVal.Render(e.Type) + "\n")
	b.WriteString(kvKey.Render("content-len:") + kvVal.Render(fmt.Sprintf("%d", e.Size)) + "\n")

	if e.Meta != nil {
		for k, v := range e.Meta {
			if k == "latencyMs" || k == "tokens" {
				continue // already shown in Timing
			}
			val := fmt.Sprintf("%v", v)
			if len(val) > width-18 {
				val = val[:width-21] + "..."
			}
			label := k + ":"
			if len(label) > 13 {
				label = label[:13]
			}
			b.WriteString(kvKey.Render(label) + kvVal.Render(val) + "\n")
		}
	}
	b.WriteString("\n" + sep + "\n\n")

	// ── Response Body ──
	b.WriteString(bold.Render("Response"))
	b.WriteString("\n")
	if e.Content != "" {
		content := e.Content
		content = strings.ReplaceAll(content, "**", "")
		content = strings.ReplaceAll(content, "```", "")
		lines := strings.Split(content, "\n")
		maxLines := 40
		if len(lines) > maxLines {
			shown := lines[:maxLines]
			shown = append(shown, muted.Render(fmt.Sprintf("\n  ... %d more lines ...", len(lines)-maxLines)))
			lines = shown
		}
		for _, line := range lines {
			if width > 6 && len(line) > width-6 {
				line = line[:width-9] + "..."
			}
			b.WriteString("  " + line + "\n")
		}
	} else {
		b.WriteString(muted.Render("  (empty body)") + "\n")
	}

	return b.String()
}
