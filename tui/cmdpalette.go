package main

import (
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/lipgloss"
)

// Command represents an actionable command in the palette.
type Command struct {
	Name     string // Display name (e.g., "Launch Swarm")
	Shortcut string // Key shortcut hint (e.g., "L")
	Category string // Category for grouping (e.g., "Control", "Navigation", "View")
	Action   string // Action identifier (e.g., "launch_swarm", "pause_agent")
}

// AllCommands is the complete list of available commands.
var AllCommands = []Command{
	{Name: "Launch Swarm", Shortcut: "L", Category: "Control", Action: "launch_swarm"},
	{Name: "Pause Selected Agent", Shortcut: "p", Category: "Control", Action: "pause_agent"},
	{Name: "Resume Selected Agent", Shortcut: "r", Category: "Control", Action: "resume_agent"},
	{Name: "Disconnect Selected Agent", Shortcut: "x", Category: "Control", Action: "disconnect_agent"},
	{Name: "Query Bus State", Shortcut: "", Category: "Debug", Action: "query_state"},
	{Name: "Get Bus Stats", Shortcut: "", Category: "Debug", Action: "get_bus_stats"},
	{Name: "Toggle Auto-Scroll", Shortcut: "s", Category: "Chat", Action: "toggle_autoscroll"},
	{Name: "Cycle Theme", Shortcut: "t", Category: "View", Action: "cycle_theme"},
	{Name: "Toggle Help", Shortcut: "?", Category: "View", Action: "toggle_help"},
	{Name: "Overview Tab", Shortcut: "1", Category: "Navigation", Action: "tab_overview"},
	{Name: "Agents Tab", Shortcut: "2", Category: "Navigation", Action: "tab_agents"},
	{Name: "Chat Tab", Shortcut: "3", Category: "Navigation", Action: "tab_chat"},
	{Name: "Hierarchy Tab", Shortcut: "4", Category: "Navigation", Action: "tab_hierarchy"},
	{Name: "Resources Tab", Shortcut: "5", Category: "Navigation", Action: "tab_resources"},
	{Name: "Logs Tab", Shortcut: "6", Category: "Navigation", Action: "tab_logs"},
}

// CmdPalette is the command palette overlay component.
type CmdPalette struct {
	Visible  bool
	Input    textinput.Model
	Commands []Command
	Filtered []Command
	Selected int
	MaxShow  int
	Offset   int // scroll offset for large filtered lists
}

// NewCmdPalette creates a new command palette with all commands loaded.
func NewCmdPalette() CmdPalette {
	ti := textinput.New()
	ti.Placeholder = "Type to search commands..."
	ti.Focus()
	ti.CharLimit = 50

	return CmdPalette{
		Visible:  false,
		Input:    ti,
		Commands: AllCommands,
		Filtered: AllCommands,
		Selected: 0,
		MaxShow:  15,
		Offset:   0,
	}
}

// Open shows the command palette and resets state.
func (p *CmdPalette) Open() {
	p.Visible = true
	p.Input.SetValue("")
	p.Filter()
	p.Selected = 0
	p.Offset = 0
}

// Close hides the command palette.
func (p *CmdPalette) Close() {
	p.Visible = false
}

// Filter applies fuzzy substring filtering based on input value.
func (p *CmdPalette) Filter() {
	query := strings.ToLower(strings.TrimSpace(p.Input.Value()))
	if query == "" {
		p.Filtered = p.Commands
		return
	}

	filtered := make([]Command, 0, len(p.Commands))
	for _, cmd := range p.Commands {
		nameLower := strings.ToLower(cmd.Name)
		if strings.Contains(nameLower, query) {
			filtered = append(filtered, cmd)
		}
	}
	p.Filtered = filtered

	// Reset selection if current is out of bounds.
	if p.Selected >= len(p.Filtered) {
		p.Selected = max(0, len(p.Filtered)-1)
	}
}

// MoveUp moves the selection cursor up.
func (p *CmdPalette) MoveUp() {
	if p.Selected > 0 {
		p.Selected--
		// Adjust offset if we scroll up past visible window.
		if p.Selected < p.Offset {
			p.Offset = p.Selected
		}
	}
}

// MoveDown moves the selection cursor down.
func (p *CmdPalette) MoveDown() {
	if p.Selected < len(p.Filtered)-1 {
		p.Selected++
		// Adjust offset if we scroll down past visible window.
		if p.Selected >= p.Offset+p.MaxShow {
			p.Offset = p.Selected - p.MaxShow + 1
		}
	}
}

// SelectedAction returns the action string of the currently selected command.
func (p *CmdPalette) SelectedAction() string {
	if p.Selected >= 0 && p.Selected < len(p.Filtered) {
		return p.Filtered[p.Selected].Action
	}
	return ""
}

// RenderCmdPalette renders the command palette as a centered overlay.
func RenderCmdPalette(p CmdPalette, width, height int, theme Theme) string {
	boxW := min(width-10, 60)
	boxH := min(height-6, p.MaxShow+5)

	var b strings.Builder

	// Title
	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(theme.Accent).
		Width(boxW - 4)
	b.WriteString(titleStyle.Render("  Command Palette"))
	b.WriteString("\n\n")

	// Input
	inputStyle := lipgloss.NewStyle().
		Foreground(theme.FG)
	promptStyle := lipgloss.NewStyle().
		Foreground(theme.Accent).
		Bold(true)
	b.WriteString(promptStyle.Render("  > "))
	b.WriteString(inputStyle.Render(p.Input.View()))
	b.WriteString("\n\n")

	// Commands grouped by category
	if len(p.Filtered) == 0 {
		mutedStyle := lipgloss.NewStyle().Foreground(theme.Muted)
		b.WriteString(mutedStyle.Render("  No matching commands"))
	} else {
		// Group commands by category for display
		categoryMap := make(map[string][]Command)
		categoryOrder := []string{}
		for _, cmd := range p.Filtered {
			if _, exists := categoryMap[cmd.Category]; !exists {
				categoryOrder = append(categoryOrder, cmd.Category)
			}
			categoryMap[cmd.Category] = append(categoryMap[cmd.Category], cmd)
		}

		globalIdx := 0
		visibleCount := 0
		for _, cat := range categoryOrder {
			cmds := categoryMap[cat]

			// Category header
			if visibleCount >= p.MaxShow {
				break
			}
			catStyle := lipgloss.NewStyle().
				Foreground(theme.Muted).
				Bold(true)
			b.WriteString(catStyle.Render("  " + cat))
			b.WriteString("\n")

			// Commands in category
			for _, cmd := range cmds {
				if globalIdx < p.Offset {
					globalIdx++
					continue
				}
				if visibleCount >= p.MaxShow {
					break
				}

				selected := globalIdx == p.Selected
				line := renderCommandLine(cmd, selected, boxW-4, theme)
				b.WriteString(line)
				b.WriteString("\n")

				globalIdx++
				visibleCount++
			}

			if visibleCount < p.MaxShow {
				b.WriteString("\n")
			}
		}
	}

	// Hint
	hintStyle := lipgloss.NewStyle().Foreground(theme.Muted)
	hint := "  Enter: execute  ↑↓: navigate  Esc: close"
	b.WriteString("\n")
	b.WriteString(hintStyle.Render(hint))

	content := b.String()

	// Box style
	boxStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(theme.Accent).
		Padding(1).
		Width(boxW).
		MaxHeight(boxH)

	box := boxStyle.Render(content)

	// Center in available space
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

// renderCommandLine renders a single command entry.
func renderCommandLine(cmd Command, selected bool, width int, theme Theme) string {
	nameStyle := lipgloss.NewStyle().Foreground(theme.FG)
	shortcutStyle := lipgloss.NewStyle().Foreground(theme.Muted)

	if selected {
		nameStyle = nameStyle.
			Background(theme.Accent).
			Foreground(theme.BG).
			Bold(true)
		shortcutStyle = shortcutStyle.
			Background(theme.Accent).
			Foreground(theme.BG)
	}

	// Format: "  Name                        [shortcut]"
	nameWidth := width - 12
	if cmd.Shortcut != "" {
		shortcut := " [" + cmd.Shortcut + "]"
		paddedName := padRight(cmd.Name, nameWidth)
		if selected {
			return nameStyle.Render("  "+paddedName) + shortcutStyle.Render(shortcut)
		}
		return nameStyle.Render("  "+paddedName) + shortcutStyle.Render(shortcut)
	}

	paddedName := padRight(cmd.Name, nameWidth)
	return nameStyle.Render("  " + paddedName)
}

// padRight pads a string with spaces to reach target width.
func padRight(s string, width int) string {
	if len(s) >= width {
		return s[:width]
	}
	return s + strings.Repeat(" ", width-len(s))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
