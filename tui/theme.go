package main

import (
	"github.com/charmbracelet/lipgloss"
)

// Theme holds all color and style definitions for the TUI.
type Theme struct {
	Name    string
	BG      lipgloss.AdaptiveColor
	FG      lipgloss.AdaptiveColor
	Accent  lipgloss.AdaptiveColor
	Border  lipgloss.AdaptiveColor
	Success lipgloss.AdaptiveColor
	Warning lipgloss.AdaptiveColor
	Error   lipgloss.AdaptiveColor
	Muted   lipgloss.AdaptiveColor

	HeaderStyle  lipgloss.Style
	PanelStyle   lipgloss.Style
	ActivePanel  lipgloss.Style
	PanelTitle   lipgloss.Style
	Divider      lipgloss.Style
	SuccessBadge lipgloss.Style
	ErrorBadge   lipgloss.Style
	WarnBadge    lipgloss.Style
}

// Badge renders a colored text badge like [sonnet] or [opus].
func (t Theme) Badge(text string) string {
	return lipgloss.NewStyle().
		Foreground(t.BG).
		Background(t.Accent).
		Bold(true).
		Padding(0, 1).
		Render(text)
}

// StatusIcon returns an icon string for a given agent status.
func (t Theme) StatusIcon(status string) string {
	switch status {
	case "running":
		return "●"
	case "spawning":
		return "◔"
	case "done":
		return "✓"
	case "failed":
		return "✗"
	case "timeout":
		return "⏱"
	default:
		return "○"
	}
}

// StatusColor returns the appropriate AdaptiveColor for an agent status.
func (t Theme) StatusColor(status string) lipgloss.AdaptiveColor {
	switch status {
	case "running":
		return t.Success
	case "spawning":
		return t.Warning
	case "done":
		return lipgloss.AdaptiveColor{Light: "#2ea043", Dark: "#56d364"}
	case "failed":
		return t.Error
	case "timeout":
		return t.Warning
	default:
		return t.Muted
	}
}

var themes = map[string]Theme{}

func init() {
	themes["dark"] = newDarkTheme()
	themes["catppuccin"] = newCatppuccinTheme()
	themes["dracula"] = newDraculaTheme()
	themes["neon"] = newNeonTheme()
}

func newDarkTheme() Theme {
	bg := lipgloss.AdaptiveColor{Light: "#ffffff", Dark: "#0d1117"}
	fg := lipgloss.AdaptiveColor{Light: "#24292f", Dark: "#c9d1d9"}
	accent := lipgloss.AdaptiveColor{Light: "#0969da", Dark: "#58a6ff"}
	border := lipgloss.AdaptiveColor{Light: "#d0d7de", Dark: "#30363d"}
	success := lipgloss.AdaptiveColor{Light: "#1a7f37", Dark: "#3fb950"}
	warning := lipgloss.AdaptiveColor{Light: "#9a6700", Dark: "#d29922"}
	errColor := lipgloss.AdaptiveColor{Light: "#cf222e", Dark: "#f85149"}
	muted := lipgloss.AdaptiveColor{Light: "#6e7781", Dark: "#484f58"}

	return Theme{
		Name:    "dark",
		BG:      bg,
		FG:      fg,
		Accent:  accent,
		Border:  border,
		Success: success,
		Warning: warning,
		Error:   errColor,
		Muted:   muted,
		HeaderStyle: lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			BorderStyle(lipgloss.DoubleBorder()).
			BorderForeground(accent),
		PanelStyle: lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(border),
		ActivePanel: lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(accent),
		PanelTitle: lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			BorderBottom(true).
			BorderForeground(accent),
		Divider: lipgloss.NewStyle().
			Foreground(muted),
		SuccessBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(success).
			Bold(true).
			Padding(0, 1),
		ErrorBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(errColor).
			Bold(true).
			Padding(0, 1),
		WarnBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(warning).
			Bold(true).
			Padding(0, 1),
	}
}

func newCatppuccinTheme() Theme {
	bg := lipgloss.AdaptiveColor{Light: "#eff1f5", Dark: "#1e1e2e"}
	fg := lipgloss.AdaptiveColor{Light: "#4c4f69", Dark: "#cdd6f4"}
	accent := lipgloss.AdaptiveColor{Light: "#1e66f5", Dark: "#89b4fa"}
	border := lipgloss.AdaptiveColor{Light: "#9ca0b0", Dark: "#45475a"}
	success := lipgloss.AdaptiveColor{Light: "#40a02b", Dark: "#a6e3a1"}
	warning := lipgloss.AdaptiveColor{Light: "#df8e1d", Dark: "#f9e2af"}
	errColor := lipgloss.AdaptiveColor{Light: "#d20f39", Dark: "#f38ba8"}
	muted := lipgloss.AdaptiveColor{Light: "#8c8fa1", Dark: "#585b70"}

	return Theme{
		Name:    "catppuccin",
		BG:      bg,
		FG:      fg,
		Accent:  accent,
		Border:  border,
		Success: success,
		Warning: warning,
		Error:   errColor,
		Muted:   muted,
		HeaderStyle: lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			BorderStyle(lipgloss.DoubleBorder()).
			BorderForeground(accent),
		PanelStyle: lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(border),
		ActivePanel: lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(accent),
		PanelTitle: lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			BorderBottom(true).
			BorderForeground(accent),
		Divider: lipgloss.NewStyle().
			Foreground(muted),
		SuccessBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(success).
			Bold(true).
			Padding(0, 1),
		ErrorBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(errColor).
			Bold(true).
			Padding(0, 1),
		WarnBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(warning).
			Bold(true).
			Padding(0, 1),
	}
}

func newDraculaTheme() Theme {
	bg := lipgloss.AdaptiveColor{Light: "#f8f8f2", Dark: "#282a36"}
	fg := lipgloss.AdaptiveColor{Light: "#282a36", Dark: "#f8f8f2"}
	accent := lipgloss.AdaptiveColor{Light: "#6272a4", Dark: "#bd93f9"}
	border := lipgloss.AdaptiveColor{Light: "#6272a4", Dark: "#44475a"}
	success := lipgloss.AdaptiveColor{Light: "#50fa7b", Dark: "#50fa7b"}
	warning := lipgloss.AdaptiveColor{Light: "#f1fa8c", Dark: "#f1fa8c"}
	errColor := lipgloss.AdaptiveColor{Light: "#ff5555", Dark: "#ff5555"}
	muted := lipgloss.AdaptiveColor{Light: "#6272a4", Dark: "#6272a4"}

	return Theme{
		Name:    "dracula",
		BG:      bg,
		FG:      fg,
		Accent:  accent,
		Border:  border,
		Success: success,
		Warning: warning,
		Error:   errColor,
		Muted:   muted,
		HeaderStyle: lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			BorderStyle(lipgloss.DoubleBorder()).
			BorderForeground(accent),
		PanelStyle: lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(border),
		ActivePanel: lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(accent),
		PanelTitle: lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			BorderBottom(true).
			BorderForeground(accent),
		Divider: lipgloss.NewStyle().
			Foreground(muted),
		SuccessBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(success).
			Bold(true).
			Padding(0, 1),
		ErrorBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(errColor).
			Bold(true).
			Padding(0, 1),
		WarnBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(warning).
			Bold(true).
			Padding(0, 1),
	}
}

func newNeonTheme() Theme {
	bg := lipgloss.AdaptiveColor{Light: "#f5f5f5", Dark: "#0a0a0a"}
	fg := lipgloss.AdaptiveColor{Light: "#1a1a1a", Dark: "#e0e0e0"}
	accent := lipgloss.AdaptiveColor{Light: "#9900cc", Dark: "#ff00ff"}
	border := lipgloss.AdaptiveColor{Light: "#cccccc", Dark: "#333333"}
	success := lipgloss.AdaptiveColor{Light: "#00aa00", Dark: "#00ff41"}
	warning := lipgloss.AdaptiveColor{Light: "#cc8800", Dark: "#ffaa00"}
	errColor := lipgloss.AdaptiveColor{Light: "#cc0000", Dark: "#ff0040"}
	muted := lipgloss.AdaptiveColor{Light: "#999999", Dark: "#555555"}

	return Theme{
		Name:    "neon",
		BG:      bg,
		FG:      fg,
		Accent:  accent,
		Border:  border,
		Success: success,
		Warning: warning,
		Error:   errColor,
		Muted:   muted,
		HeaderStyle: lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			BorderStyle(lipgloss.DoubleBorder()).
			BorderForeground(accent),
		PanelStyle: lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(border),
		ActivePanel: lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(accent),
		PanelTitle: lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			BorderBottom(true).
			BorderForeground(accent),
		Divider: lipgloss.NewStyle().
			Foreground(muted),
		SuccessBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(success).
			Bold(true).
			Padding(0, 1),
		ErrorBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(errColor).
			Bold(true).
			Padding(0, 1),
		WarnBadge: lipgloss.NewStyle().
			Foreground(bg).
			Background(warning).
			Bold(true).
			Padding(0, 1),
	}
}

// GetTheme returns a theme by name, falling back to "dark".
func GetTheme(name string) Theme {
	if t, ok := themes[name]; ok {
		return t
	}
	return themes["dark"]
}

// ThemeNames returns the ordered list of available theme names.
func ThemeNames() []string {
	return []string{"dark", "catppuccin", "dracula", "neon"}
}

// CycleTheme returns the next theme name after the given one.
func CycleTheme(current string) string {
	names := ThemeNames()
	for i, n := range names {
		if n == current {
			return names[(i+1)%len(names)]
		}
	}
	return names[0]
}
