package main

import (
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/lipgloss"
)

// ChatSender manages the chat input and message sending.
type ChatSender struct {
	Input      textinput.Model
	Active     bool   // Whether input is focused
	TargetType string // "broadcast" or "direct"
	TargetID   string // agent ID for direct messages
	Agents     []string
	AgentIdx   int // selected agent index for cycling
}

// NewChatSender creates a new chat sender component.
func NewChatSender() ChatSender {
	ti := textinput.New()
	ti.Placeholder = "Type a message..."
	ti.CharLimit = 256

	return ChatSender{
		Input:      ti,
		Active:     false,
		TargetType: "broadcast",
		TargetID:   "",
		Agents:     []string{},
		AgentIdx:   -1,
	}
}

// Activate focuses the chat input for message composition.
func (s *ChatSender) Activate() {
	s.Active = true
	s.Input.Focus()
}

// Deactivate unfocuses the chat input.
func (s *ChatSender) Deactivate() {
	s.Active = false
	s.Input.Blur()
	s.Input.SetValue("")
}

// UpdateAgents refreshes the available agent list for targeting.
func (s *ChatSender) UpdateAgents(agents []Agent) {
	ids := make([]string, 0, len(agents))
	for _, a := range agents {
		ids = append(ids, a.ID)
	}
	s.Agents = ids

	// Reset target if it no longer exists.
	if s.TargetType == "direct" && s.TargetID != "" {
		found := false
		for _, id := range ids {
			if id == s.TargetID {
				found = true
				break
			}
		}
		if !found {
			s.TargetType = "broadcast"
			s.TargetID = ""
			s.AgentIdx = -1
		}
	}
}

// CycleTarget cycles between broadcast and available agents.
func (s *ChatSender) CycleTarget() {
	if len(s.Agents) == 0 {
		s.TargetType = "broadcast"
		s.TargetID = ""
		s.AgentIdx = -1
		return
	}

	if s.TargetType == "broadcast" {
		// Switch to first agent.
		s.TargetType = "direct"
		s.AgentIdx = 0
		s.TargetID = s.Agents[0]
	} else {
		// Cycle through agents, then back to broadcast.
		s.AgentIdx++
		if s.AgentIdx >= len(s.Agents) {
			s.TargetType = "broadcast"
			s.TargetID = ""
			s.AgentIdx = -1
		} else {
			s.TargetID = s.Agents[s.AgentIdx]
		}
	}
}

// ComposeMessage builds an IPC message map from current input state.
func (s *ChatSender) ComposeMessage() map[string]interface{} {
	msg := map[string]interface{}{
		"type":    "chat",
		"payload": s.Input.Value(),
	}

	if s.TargetType == "broadcast" {
		msg["topic"] = "broadcast"
	} else {
		msg["to"] = s.TargetID
	}

	return msg
}

// RenderChatInput renders the chat input bar with target indicator.
func RenderChatInput(s ChatSender, width int, theme Theme) string {
	targetStyle := lipgloss.NewStyle().
		Foreground(theme.Accent).
		Bold(true)
	promptStyle := lipgloss.NewStyle().
		Foreground(theme.FG)
	hintStyle := lipgloss.NewStyle().
		Foreground(theme.Muted)

	var target string
	if s.TargetType == "broadcast" {
		target = targetStyle.Render("[broadcast ▸]")
	} else {
		target = targetStyle.Render("[→ " + s.TargetID + " ▸]")
	}

	inputView := s.Input.View()
	hint := hintStyle.Render("(Tab: cycle target, Enter: send, Esc: cancel)")

	// Layout: [target] input                       hint
	availWidth := width - lipgloss.Width(target) - lipgloss.Width(hint) - 4
	if availWidth < 20 {
		availWidth = 20
	}

	// Truncate input view if needed.
	inputRendered := promptStyle.Render(inputView)
	if lipgloss.Width(inputRendered) > availWidth {
		truncated := inputView
		if len(truncated) > availWidth-3 {
			truncated = truncated[:availWidth-3] + "..."
		}
		inputRendered = promptStyle.Render(truncated)
	}

	line := lipgloss.JoinHorizontal(
		lipgloss.Left,
		target,
		" ",
		inputRendered,
	)

	// Pad to full width and append hint
	padding := width - lipgloss.Width(line) - lipgloss.Width(hint) - 2
	if padding < 0 {
		padding = 0
	}

	fullLine := line + lipgloss.NewStyle().Width(padding).Render("") + " " + hint

	return lipgloss.NewStyle().Width(width).Render(fullLine)
}
