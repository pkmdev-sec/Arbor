package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ConflictEntry represents a single file conflict.
type ConflictEntry struct {
	File     string   // relative file path
	Agents   []string // agent IDs that modified the file
	Resolved bool
	Error    string
}

// ParseConflicts extracts conflict data from swarm result JSON.
func ParseConflicts(runDir string) []ConflictEntry {
	var conflicts []ConflictEntry

	// Try to read the main swarm result file
	resultPath := filepath.Join(runDir, "swarm-result.json")
	data, err := os.ReadFile(resultPath)
	if err != nil {
		// Fallback: infer conflicts from agent result files
		return inferConflictsFromResults(runDir)
	}

	var result struct {
		ConflictReport []struct {
			File     string   `json:"file"`
			Agents   []string `json:"agents"`
			Resolved bool     `json:"resolved"`
			Error    string   `json:"error"`
		} `json:"conflict_report"`
	}

	if err := json.Unmarshal(data, &result); err != nil {
		return inferConflictsFromResults(runDir)
	}

	for _, cr := range result.ConflictReport {
		conflicts = append(conflicts, ConflictEntry{
			File:     cr.File,
			Agents:   cr.Agents,
			Resolved: cr.Resolved,
			Error:    cr.Error,
		})
	}

	return conflicts
}

// inferConflictsFromResults builds conflict data by analyzing agent result files.
func inferConflictsFromResults(runDir string) []ConflictEntry {
	// Map files to agents that modified them
	fileAgents := map[string][]string{}

	files, err := os.ReadDir(runDir)
	if err != nil {
		return nil
	}

	for _, f := range files {
		if !strings.HasSuffix(f.Name(), "-result.json") {
			continue
		}

		agentID := strings.TrimSuffix(f.Name(), "-result.json")
		data, err := os.ReadFile(filepath.Join(runDir, f.Name()))
		if err != nil {
			continue
		}

		var result struct {
			FilesChanged []struct {
				Path   string `json:"path"`
				Action string `json:"action"`
			} `json:"files_changed"`
		}

		if err := json.Unmarshal(data, &result); err != nil {
			continue
		}

		for _, fc := range result.FilesChanged {
			fileAgents[fc.Path] = append(fileAgents[fc.Path], agentID)
		}
	}

	// Build conflicts for files modified by multiple agents
	var conflicts []ConflictEntry
	for file, agents := range fileAgents {
		if len(agents) > 1 {
			conflicts = append(conflicts, ConflictEntry{
				File:     file,
				Agents:   agents,
				Resolved: false,
				Error:    fmt.Sprintf("modified by %d agents", len(agents)),
			})
		}
	}

	return conflicts
}

// RenderConflictPanel renders the conflict list.
func RenderConflictPanel(conflicts []ConflictEntry, width int, theme Theme) string {
	if len(conflicts) == 0 {
		return lipgloss.NewStyle().
			Foreground(theme.Success).
			Render("  No file conflicts detected")
	}

	var b strings.Builder

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(theme.Accent)
	mutedStyle := lipgloss.NewStyle().Foreground(theme.Muted)

	resolvedCount := 0
	for _, c := range conflicts {
		if c.Resolved {
			resolvedCount++
		}
	}

	b.WriteString(headerStyle.Render(fmt.Sprintf("  File Conflicts (%d files, %d resolved)", len(conflicts), resolvedCount)))
	b.WriteString("\n\n")

	for _, conflict := range conflicts {
		// Status icon
		statusIcon := "✗"
		statusClr := theme.Error
		statusMsg := "unresolved"

		if conflict.Resolved {
			statusIcon = "✓"
			statusClr = theme.Success
			statusMsg = "resolved"
		}

		iconStyle := lipgloss.NewStyle().Foreground(statusClr)

		// File path
		file := conflict.File
		maxFile := width - 20
		if maxFile > 0 && len(file) > maxFile {
			file = "..." + file[len(file)-maxFile+3:]
		}

		b.WriteString(fmt.Sprintf("  %s %s", iconStyle.Render(statusIcon), file))
		b.WriteString("\n")

		// Agents involved
		agentList := strings.Join(conflict.Agents, ", ")
		b.WriteString(mutedStyle.Render("    Modified by: "))
		b.WriteString(agentList)
		b.WriteString("\n")

		// Status message
		b.WriteString(mutedStyle.Render("    Status: "))
		statusStyle := lipgloss.NewStyle().Foreground(statusClr)
		b.WriteString(statusStyle.Render(statusMsg))

		// Error detail
		if conflict.Error != "" && !conflict.Resolved {
			errMsg := conflict.Error
			maxErr := width - 20
			if maxErr > 0 && len(errMsg) > maxErr {
				errMsg = errMsg[:maxErr-3] + "..."
			}
			b.WriteString(mutedStyle.Render(" — "))
			b.WriteString(lipgloss.NewStyle().Foreground(theme.Error).Render(errMsg))
		} else if conflict.Resolved {
			b.WriteString(mutedStyle.Render(" — three-way merge succeeded"))
		}

		b.WriteString("\n\n")
	}

	return b.String()
}
