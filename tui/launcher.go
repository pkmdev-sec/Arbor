package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var (
	swarmModes  = []string{"parallel", "swarm", "pipeline", "hierarchical", "single", "review"}
	swarmDepths = []string{"shallow", "normal", "thorough"}
)

// LauncherModel is the swarm launcher form.
type LauncherModel struct {
	taskInput    textarea.Model
	agentInput   textinput.Model
	timeoutInput textinput.Model
	modeIdx      int
	depthIdx     int
	focused      int
	launched     bool
	lastRunDir   string
	lastPID      int
	err          error
}

// NewLauncherModel creates a new swarm launcher.
func NewLauncherModel() LauncherModel {
	ta := textarea.New()
	ta.Placeholder = "Enter task description..."
	ta.ShowLineNumbers = false
	ta.SetWidth(60)
	ta.SetHeight(5)
	ta.Focus()

	agentInput := textinput.New()
	agentInput.Placeholder = "3"
	agentInput.SetValue("3")
	agentInput.CharLimit = 2

	timeoutInput := textinput.New()
	timeoutInput.Placeholder = "600"
	timeoutInput.SetValue("600")
	timeoutInput.CharLimit = 5

	return LauncherModel{
		taskInput:    ta,
		agentInput:   agentInput,
		timeoutInput: timeoutInput,
		modeIdx:      0,
		depthIdx:     1, // normal
		focused:      0,
	}
}

// Update handles launcher input.
func (l LauncherModel) Update(msg tea.Msg) (LauncherModel, tea.Cmd) {
	var cmd tea.Cmd

	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch {
		case key.Matches(msg, key.NewBinding(key.WithKeys("tab"))):
			l.focused = (l.focused + 1) % 6
			l.updateFocus()
			return l, nil

		case key.Matches(msg, key.NewBinding(key.WithKeys("shift+tab"))):
			l.focused = (l.focused - 1 + 6) % 6
			l.updateFocus()
			return l, nil

		case key.Matches(msg, key.NewBinding(key.WithKeys("ctrl+enter"))):
			return l, l.Launch()

		case key.Matches(msg, key.NewBinding(key.WithKeys("enter"))):
			if l.focused == 5 { // Launch button
				return l, l.Launch()
			}
		}

		// Field-specific handling
		switch l.focused {
		case 0: // Task textarea
			l.taskInput, cmd = l.taskInput.Update(msg)
			return l, cmd

		case 1: // Mode selector
			if msg.String() == "left" || msg.String() == "h" {
				l.modeIdx = (l.modeIdx - 1 + len(swarmModes)) % len(swarmModes)
				return l, nil
			}
			if msg.String() == "right" || msg.String() == "l" {
				l.modeIdx = (l.modeIdx + 1) % len(swarmModes)
				return l, nil
			}

		case 2: // Depth selector
			if msg.String() == "left" || msg.String() == "h" {
				l.depthIdx = (l.depthIdx - 1 + len(swarmDepths)) % len(swarmDepths)
				return l, nil
			}
			if msg.String() == "right" || msg.String() == "l" {
				l.depthIdx = (l.depthIdx + 1) % len(swarmDepths)
				return l, nil
			}

		case 3: // Agent count input
			l.agentInput, cmd = l.agentInput.Update(msg)
			return l, cmd

		case 4: // Timeout input
			l.timeoutInput, cmd = l.timeoutInput.Update(msg)
			return l, cmd
		}

	case launchSuccessMsg:
		l.launched = true
		l.lastPID = msg.pid
		l.lastRunDir = msg.runDir
		l.err = nil
		return l, nil

	case launchErrMsg:
		l.launched = false
		l.err = msg.err
		return l, nil
	}

	return l, nil
}

func (l *LauncherModel) updateFocus() {
	l.taskInput.Blur()
	l.agentInput.Blur()
	l.timeoutInput.Blur()

	switch l.focused {
	case 0:
		l.taskInput.Focus()
	case 3:
		l.agentInput.Focus()
	case 4:
		l.timeoutInput.Focus()
	}
}

// Launch spawns the swarm command.
func (l *LauncherModel) Launch() tea.Cmd {
	return func() tea.Msg {
		task := strings.TrimSpace(l.taskInput.Value())
		if task == "" {
			return launchErrMsg{err: fmt.Errorf("task cannot be empty")}
		}

		agentCount := 3
		if val := strings.TrimSpace(l.agentInput.Value()); val != "" {
			if n, err := strconv.Atoi(val); err == nil && n >= 1 && n <= 10 {
				agentCount = n
			}
		}

		timeout := 600
		if val := strings.TrimSpace(l.timeoutInput.Value()); val != "" {
			if n, err := strconv.Atoi(val); err == nil && n >= 60 && n <= 3600 {
				timeout = n
			}
		}

		args := []string{
			"--mode", swarmModes[l.modeIdx],
			"--depth", swarmDepths[l.depthIdx],
			"--agents", strconv.Itoa(agentCount),
			"--timeout", strconv.Itoa(timeout),
			task,
		}

		cmd := exec.Command("arbor-swarm", args...)
		// Use current working directory (arbor-swarm binary is on PATH)
		if cwd, err := os.Getwd(); err == nil {
			cmd.Dir = cwd
		}

		if err := cmd.Start(); err != nil {
			return launchErrMsg{err: err}
		}

		// Bug H fix: Reap process to prevent zombies
		go func() {
			_ = cmd.Wait()
		}()

		// Swarm creates /tmp/swarm/<random-8-char-id>/ — find the newest dir
		runDir := findNewestRunDir("/tmp/swarm")
		return launchSuccessMsg{pid: cmd.Process.Pid, runDir: runDir}
	}
}

// View renders the launcher form.
func (l LauncherModel) View(width, height int, theme Theme) string {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(theme.Accent)
	labelStyle := lipgloss.NewStyle().Foreground(theme.FG).Width(15)
	focusedStyle := lipgloss.NewStyle().Foreground(theme.Accent).Bold(true)
	mutedStyle := lipgloss.NewStyle().Foreground(theme.Muted)
	focusIndicator := lipgloss.NewStyle().Foreground(theme.Accent).Render("▎")

	var b strings.Builder

	b.WriteString(headerStyle.Render("  Swarm Launcher"))
	b.WriteString("\n\n")

	// Task
	taskPrefix := "  "
	if l.focused == 0 {
		taskPrefix = focusIndicator + " "
		b.WriteString(focusedStyle.Render("  Task:"))
	} else {
		b.WriteString(labelStyle.Render("  Task:"))
	}
	b.WriteString("\n")
	b.WriteString(taskPrefix + l.taskInput.View())
	b.WriteString("\n")

	// Validation message
	if l.focused == 0 && strings.TrimSpace(l.taskInput.Value()) == "" {
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Error).Render("  ⚠ Task is required"))
		b.WriteString("\n")
	}
	b.WriteString("\n")

	// Mode
	modePrefix := "  "
	if l.focused == 1 {
		modePrefix = focusIndicator + " "
		b.WriteString(focusedStyle.Render("  Mode:"))
	} else {
		b.WriteString(labelStyle.Render("  Mode:"))
	}

	// Visual selector chips - NO BORDERS, only background/foreground
	modeChips := []string{}
	for i, mode := range swarmModes {
		if i == l.modeIdx {
			// Selected: background color ONLY, no border
			modeChips = append(modeChips, lipgloss.NewStyle().
				Background(theme.Accent).
				Foreground(theme.BG).
				Padding(0, 1).
				Render(mode))
		} else {
			// Unselected: foreground color ONLY, no border
			modeChips = append(modeChips, lipgloss.NewStyle().
				Foreground(theme.Muted).
				Padding(0, 1).
				Render(mode))
		}
	}
	b.WriteString("\n")
	b.WriteString(modePrefix + lipgloss.JoinHorizontal(lipgloss.Center, modeChips...))
	if l.focused == 1 {
		b.WriteString(mutedStyle.Render("  (use ←/→)"))
	}
	b.WriteString("\n\n")

	// Depth
	depthPrefix := "  "
	if l.focused == 2 {
		depthPrefix = focusIndicator + " "
		b.WriteString(focusedStyle.Render("  Depth:"))
	} else {
		b.WriteString(labelStyle.Render("  Depth:"))
	}

	// Visual selector chips - NO BORDERS, only background/foreground
	depthChips := []string{}
	for i, depth := range swarmDepths {
		if i == l.depthIdx {
			// Selected: background color ONLY, no border
			depthChips = append(depthChips, lipgloss.NewStyle().
				Background(theme.Accent).
				Foreground(theme.BG).
				Padding(0, 1).
				Render(depth))
		} else {
			// Unselected: foreground color ONLY, no border
			depthChips = append(depthChips, lipgloss.NewStyle().
				Foreground(theme.Muted).
				Padding(0, 1).
				Render(depth))
		}
	}
	b.WriteString("\n")
	b.WriteString(depthPrefix + lipgloss.JoinHorizontal(lipgloss.Center, depthChips...))
	if l.focused == 2 {
		b.WriteString(mutedStyle.Render("  (use ←/→)"))
	}
	b.WriteString("\n\n")

	// Agent count
	agentLabel := "  Agents:"
	if l.focused == 3 {
		b.WriteString(focusedStyle.Render(agentLabel))
	} else {
		b.WriteString(labelStyle.Render(agentLabel))
	}
	b.WriteString("     " + l.agentInput.View())
	b.WriteString(mutedStyle.Render("  (1-10)"))
	b.WriteString("\n\n")

	// Timeout
	timeoutLabel := "  Timeout:"
	if l.focused == 4 {
		b.WriteString(focusedStyle.Render(timeoutLabel))
	} else {
		b.WriteString(labelStyle.Render(timeoutLabel))
	}
	b.WriteString("    " + l.timeoutInput.View())
	b.WriteString(mutedStyle.Render("  seconds (60-3600)"))
	b.WriteString("\n\n")

	// Launch button (field 5)
	launchBtn := "  [ Launch Swarm ]"
	if l.focused == 5 {
		launchBtn = focusedStyle.Render(launchBtn)
		b.WriteString(focusIndicator + launchBtn)
		b.WriteString(mutedStyle.Render("  (press Enter)"))
	} else {
		launchBtn = mutedStyle.Render(launchBtn)
		b.WriteString(" " + launchBtn)
		b.WriteString(mutedStyle.Render("  (Ctrl+Enter from any field)"))
	}
	b.WriteString("\n\n")

	// Status
	if l.launched {
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Success).Render(fmt.Sprintf("  ✓ Swarm launched (PID %d)", l.lastPID)))
		b.WriteString("\n")
		b.WriteString(mutedStyle.Render("  Run dir: " + l.lastRunDir))
		b.WriteString("\n")
	}

	if l.err != nil {
		b.WriteString(lipgloss.NewStyle().Foreground(theme.Error).Render("  ✗ Error: " + l.err.Error()))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(mutedStyle.Render("  Navigation: Tab/Shift+Tab to move between fields"))

	return b.String()
}

// findNewestRunDir polls for the newest directory under base, waiting briefly
// for swarm to create its run directory after startup.
func findNewestRunDir(base string) string {
	for attempt := 0; attempt < 10; attempt++ {
		entries, err := os.ReadDir(base)
		if err == nil {
			var newest string
			var newestTime time.Time
			for _, e := range entries {
				if !e.IsDir() {
					continue
				}
				info, err := e.Info()
				if err != nil {
					continue
				}
				if info.ModTime().After(newestTime) {
					newestTime = info.ModTime()
					newest = filepath.Join(base, e.Name())
				}
			}
			// Accept if the directory was created in the last 5 seconds
			if newest != "" && time.Since(newestTime) < 5*time.Second {
				return newest
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return base
}

// Bubble Tea messages for launch results.
type launchSuccessMsg struct {
	pid    int
	runDir string
}

type launchErrMsg struct {
	err error
}
