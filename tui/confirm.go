package main

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ConfirmDialog is a centered confirmation dialog overlay.
type ConfirmDialog struct {
	Visible bool
	Title   string
	Message string
	OnYes   func()
	OnNo    func()
}

// Render renders the confirmation dialog as an overlay box.
func (c *ConfirmDialog) Render(width, height int, theme Theme) string {
	if !c.Visible {
		return ""
	}

	boxWidth := 50
	if boxWidth > width-4 {
		boxWidth = width - 4
	}

	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(theme.Accent).
		Align(lipgloss.Center).
		Width(boxWidth - 4)

	messageStyle := lipgloss.NewStyle().
		Foreground(theme.FG).
		Align(lipgloss.Center).
		Width(boxWidth - 4)

	helpStyle := lipgloss.NewStyle().
		Foreground(theme.Muted).
		Align(lipgloss.Center).
		Width(boxWidth - 4)

	content := lipgloss.JoinVertical(
		lipgloss.Center,
		titleStyle.Render(c.Title),
		"",
		messageStyle.Render(c.Message),
		"",
		helpStyle.Render("y = yes  n = no  esc = cancel"),
	)

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(theme.Accent).
		Padding(1, 2).
		Width(boxWidth).
		Render(content)

	// Center the box on screen
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

// NewConfirmDialog creates a new confirmation dialog.
func NewConfirmDialog(title, message string, onYes, onNo func()) ConfirmDialog {
	return ConfirmDialog{
		Visible: true,
		Title:   title,
		Message: message,
		OnYes:   onYes,
		OnNo:    onNo,
	}
}

// Hide hides the confirmation dialog.
func (c *ConfirmDialog) Hide() {
	c.Visible = false
}

// RenderConfirmOverlay renders the confirm dialog as an overlay if visible.
func RenderConfirmOverlay(baseView string, dialog ConfirmDialog, width, height int, theme Theme) string {
	if !dialog.Visible {
		return baseView
	}

	// Split base view into lines
	baseLines := strings.Split(baseView, "\n")
	overlay := dialog.Render(width, height, theme)
	overlayLines := strings.Split(overlay, "\n")

	// Overlay on top of base
	result := make([]string, height)
	overlayStart := (height - len(overlayLines)) / 2

	for i := 0; i < height; i++ {
		if i >= overlayStart && i < overlayStart+len(overlayLines) {
			result[i] = overlayLines[i-overlayStart]
		} else if i < len(baseLines) {
			result[i] = baseLines[i]
		} else {
			result[i] = ""
		}
	}

	return strings.Join(result, "\n")
}
