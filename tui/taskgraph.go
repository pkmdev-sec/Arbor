package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// TaskNode represents a node in the task dependency graph.
type TaskNode struct {
	Title     string
	Status    string   // pending, running, done, failed
	DependsOn []string // titles of dependencies
	Model     string
	Agent     string // assigned agent ID
	WaveIdx   int    // which execution wave
}

// TaskGraph holds the full dependency graph.
type TaskGraph struct {
	Tasks []TaskNode
	Waves [][]int // groups of task indices per wave
}

// ParseTaskGraph extracts task graph from a swarm run directory.
// Reads decomposition output and agent results.
func ParseTaskGraph(runDir string) *TaskGraph {
	graph := &TaskGraph{
		Tasks: []TaskNode{},
		Waves: [][]int{},
	}

	// Read decomposition file to get subtasks structure
	decompPath := filepath.Join(runDir, "decomposition.json")
	data, err := os.ReadFile(decompPath)
	if err != nil {
		// Fallback: try to infer from agent result files
		return parseTaskGraphFromResults(runDir)
	}

	var decomp struct {
		Subtasks []struct {
			Title     string   `json:"title"`
			DependsOn []string `json:"depends_on"`
		} `json:"subtasks"`
	}
	if err := json.Unmarshal(data, &decomp); err != nil {
		return parseTaskGraphFromResults(runDir)
	}

	// Build tasks from decomposition
	for i, st := range decomp.Subtasks {
		node := TaskNode{
			Title:     st.Title,
			Status:    "pending",
			DependsOn: st.DependsOn,
			WaveIdx:   -1,
		}

		// Try to find matching agent result
		resultPath := filepath.Join(runDir, fmt.Sprintf("agent-%02d-result.json", i+1))
		if resultData, err := os.ReadFile(resultPath); err == nil {
			var result struct {
				Status string `json:"status"`
				Model  string `json:"model"`
			}
			if json.Unmarshal(resultData, &result) == nil {
				node.Status = mapStatus(result.Status)
				node.Model = result.Model
				node.Agent = fmt.Sprintf("agent-%02d", i+1)
			}
		}

		// Check for progress file (running)
		progressPath := filepath.Join(runDir, fmt.Sprintf("agent-%02d.progress.json", i+1))
		if _, err := os.Stat(progressPath); err == nil {
			node.Status = "running"
		}

		graph.Tasks = append(graph.Tasks, node)
	}

	// Build wave structure from dependencies
	buildWaves(graph)

	return graph
}

// parseTaskGraphFromResults builds a graph by inferring from result files.
func parseTaskGraphFromResults(runDir string) *TaskGraph {
	graph := &TaskGraph{
		Tasks: []TaskNode{},
		Waves: [][]int{},
	}

	files, err := os.ReadDir(runDir)
	if err != nil {
		return graph
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
			Status string `json:"status"`
			Model  string `json:"model"`
			Task   string `json:"task"`
		}
		if err := json.Unmarshal(data, &result); err != nil {
			continue
		}

		title := result.Task
		if title == "" {
			title = agentID
		}

		node := TaskNode{
			Title:     title,
			Status:    mapStatus(result.Status),
			DependsOn: []string{},
			Model:     result.Model,
			Agent:     agentID,
			WaveIdx:   0,
		}

		graph.Tasks = append(graph.Tasks, node)
	}

	// All tasks in wave 0 (no dependency info)
	if len(graph.Tasks) > 0 {
		wave := make([]int, len(graph.Tasks))
		for i := range wave {
			wave[i] = i
		}
		graph.Waves = [][]int{wave}
	}

	return graph
}

// buildWaves computes wave indices based on dependency structure.
func buildWaves(graph *TaskGraph) {
	if len(graph.Tasks) == 0 {
		return
	}

	// Map task titles to indices
	titleIdx := map[string]int{}
	for i, t := range graph.Tasks {
		titleIdx[t.Title] = i
	}

	// Assign wave indices
	assigned := map[int]bool{}
	waves := [][]int{}

	for len(assigned) < len(graph.Tasks) {
		wave := []int{}

		for i, task := range graph.Tasks {
			if assigned[i] {
				continue
			}

			// Check if all dependencies are assigned
			canAssign := true
			maxDepWave := -1
			for _, depTitle := range task.DependsOn {
				if depIdx, ok := titleIdx[depTitle]; ok {
					if !assigned[depIdx] {
						canAssign = false
						break
					}
					if graph.Tasks[depIdx].WaveIdx > maxDepWave {
						maxDepWave = graph.Tasks[depIdx].WaveIdx
					}
				}
			}

			if canAssign {
				waveIdx := maxDepWave + 1
				graph.Tasks[i].WaveIdx = waveIdx
				wave = append(wave, i)
				assigned[i] = true
			}
		}

		if len(wave) == 0 {
			// Deadlock or cycle - assign remaining to next wave
			for i := range graph.Tasks {
				if !assigned[i] {
					graph.Tasks[i].WaveIdx = len(waves)
					wave = append(wave, i)
					assigned[i] = true
				}
			}
		}

		waves = append(waves, wave)
	}

	graph.Waves = waves
}

// mapStatus normalizes status strings to canonical values.
func mapStatus(status string) string {
	switch status {
	case "completed", "success":
		return "done"
	case "running", "in_progress":
		return "running"
	case "failed", "error":
		return "failed"
	case "pending", "waiting":
		return "pending"
	default:
		return "pending"
	}
}

// RenderTaskGraph renders the DAG as an ASCII tree with status indicators.
func RenderTaskGraph(graph *TaskGraph, width int, theme Theme) string {
	if graph == nil || len(graph.Tasks) == 0 {
		return lipgloss.NewStyle().Foreground(theme.Muted).Render("  No task graph data")
	}

	var b strings.Builder

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(theme.Accent)
	mutedStyle := lipgloss.NewStyle().Foreground(theme.Muted)

	waveCount := len(graph.Waves)
	taskCount := len(graph.Tasks)

	b.WriteString(headerStyle.Render(fmt.Sprintf("  Task Graph (%d waves, %d tasks)", waveCount, taskCount)))
	b.WriteString("\n\n")

	for waveIdx, wave := range graph.Waves {
		// Wave header
		b.WriteString(headerStyle.Render(fmt.Sprintf("  Wave %d ", waveIdx+1)))
		b.WriteString(mutedStyle.Render(strings.Repeat("─", width-12)))
		b.WriteString("\n")

		// Show dependencies for this wave
		if waveIdx > 0 {
			b.WriteString(mutedStyle.Render(fmt.Sprintf("  (depends on Wave %d)", waveIdx)))
			b.WriteString("\n")
		}

		// Render tasks in this wave
		for _, taskIdx := range wave {
			if taskIdx >= len(graph.Tasks) {
				continue
			}
			task := graph.Tasks[taskIdx]

			// Status icon and color
			statusIcon := theme.StatusIcon(task.Status)
			statusClr := theme.StatusColor(task.Status)
			iconStyle := lipgloss.NewStyle().Foreground(statusClr)

			// Model badge
			modelBadge := ""
			if task.Model != "" {
				modelBadge = lipgloss.NewStyle().
					Foreground(theme.Muted).
					Render(fmt.Sprintf("[%s]", task.Model))
			}

			// Agent ID
			agentStr := ""
			if task.Agent != "" {
				agentStr = lipgloss.NewStyle().
					Foreground(theme.Muted).
					Render(fmt.Sprintf("  %s", task.Agent))
			}

			// Status text
			statusText := ""
			if task.Status == "running" {
				statusText = lipgloss.NewStyle().
					Foreground(theme.Warning).
					Render("  running...")
			}

			title := task.Title
			maxTitle := width - 30
			if maxTitle > 0 && len(title) > maxTitle {
				title = title[:maxTitle-3] + "..."
			}

			line := fmt.Sprintf("  %s %s %s%s%s",
				iconStyle.Render(statusIcon),
				title,
				modelBadge,
				agentStr,
				statusText,
			)

			if width > 0 && lipgloss.Width(line) > width {
				line = line[:width]
			}

			b.WriteString(line)
			b.WriteString("\n")
		}

		b.WriteString("\n")
	}

	return b.String()
}
