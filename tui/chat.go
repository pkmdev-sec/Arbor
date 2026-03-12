package main

import (
	"fmt"
	"strings"
	"sync"

	"github.com/charmbracelet/bubbles/viewport"
	"github.com/charmbracelet/lipgloss"
)

const maxMessages = 500

// MessageRing is a ring buffer for IPC messages.
type MessageRing struct {
	mu   sync.Mutex // Bug G fix: Mutex for thread-safe access
	msgs []IPCMessage
	head int
	size int
}

// NewMessageRing creates a ring buffer with the given capacity.
func NewMessageRing(cap int) *MessageRing {
	return &MessageRing{
		msgs: make([]IPCMessage, cap),
	}
}

// Push adds a message to the ring buffer.
func (r *MessageRing) Push(msg IPCMessage) {
	// Bug G fix: Lock during mutation
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs[r.head] = msg
	r.head = (r.head + 1) % len(r.msgs)
	if r.size < len(r.msgs) {
		r.size++
	}
}

// All returns all messages in chronological order.
func (r *MessageRing) All() []IPCMessage {
	// Bug G fix: Lock during read
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.size == 0 {
		return nil
	}
	result := make([]IPCMessage, 0, r.size)
	start := (r.head - r.size + len(r.msgs)) % len(r.msgs)
	for i := 0; i < r.size; i++ {
		idx := (start + i) % len(r.msgs)
		result = append(result, r.msgs[idx])
	}
	return result
}

// Len returns the number of messages in the buffer.
func (r *MessageRing) Len() int {
	// Bug G fix: Lock during read
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.size
}

// ChatFilter defines filtering criteria for the message feed.
type ChatFilter struct {
	Source string
	Target string
	Topic  string
	Type   string
}

// Matches returns true if the message matches the filter.
func (f ChatFilter) Matches(msg IPCMessage) bool {
	if f.Source != "" && msg.From != f.Source {
		return false
	}
	if f.Target != "" && msg.To != f.Target {
		return false
	}
	if f.Topic != "" && msg.Topic != f.Topic {
		return false
	}
	if f.Type != "" && msg.Type != f.Type {
		return false
	}
	return true
}

// IsEmpty returns true if no filters are set.
func (f ChatFilter) IsEmpty() bool {
	return f.Source == "" && f.Target == "" && f.Topic == "" && f.Type == ""
}

// RenderChatPanel renders the full chat message feed for the viewport.
func RenderChatPanel(messages []IPCMessage, filter ChatFilter, width int, theme Theme) string {
	if len(messages) == 0 {
		return lipgloss.NewStyle().
			Foreground(theme.Muted).
			Render("  No messages yet. Waiting for IPC traffic...")
	}

	var b strings.Builder

	for _, msg := range messages {
		if !filter.IsEmpty() && !filter.Matches(msg) {
			continue
		}

		// Timestamp
		timeStyle := lipgloss.NewStyle().Foreground(theme.Muted)
		ts := timeStyle.Render(msg.TimeFormatted())

		// Type badge
		typeColor := lipgloss.Color(msg.TypeColor())
		typeBadge := lipgloss.NewStyle().
			Foreground(typeColor).
			Bold(true).
			Render(msg.Type)

		// Source → Target
		srcStyle := lipgloss.NewStyle().Foreground(theme.Accent)
		src := srcStyle.Render(msg.From)
		arrow := lipgloss.NewStyle().Foreground(theme.Muted).Render("→")
		target := msg.To
		if target == "" {
			target = msg.Topic
		}
		if target == "" {
			target = "*"
		}
		tgtStyle := lipgloss.NewStyle().Foreground(theme.FG)
		tgt := tgtStyle.Render(target)

		// Payload preview
		payload := msg.PayloadString()
		// Bug H17 fix: Add minimum width validation for narrow terminals
		maxPayload := width - 50
		if maxPayload < 20 {
			maxPayload = 20
		}
		if len(payload) > maxPayload {
			payload = payload[:maxPayload-3] + "..."
		}
		payload = strings.ReplaceAll(payload, "\n", " ")

		line := fmt.Sprintf("%s %s %s%s%s %s",
			ts, typeBadge, src, arrow, tgt, payload)

		b.WriteString(line)
		b.WriteString("\n")
	}

	return b.String()
}

// RenderFilterBar renders the active filter indicators.
func RenderFilterBar(filter ChatFilter, theme Theme) string {
	if filter.IsEmpty() {
		return lipgloss.NewStyle().Foreground(theme.Muted).Render("  Filter: none")
	}

	parts := []string{"  Filter:"}
	activeStyle := lipgloss.NewStyle().
		Foreground(theme.Accent).
		Bold(true)

	if filter.Source != "" {
		parts = append(parts, activeStyle.Render("source="+filter.Source))
	}
	if filter.Target != "" {
		parts = append(parts, activeStyle.Render("target="+filter.Target))
	}
	if filter.Topic != "" {
		parts = append(parts, activeStyle.Render("topic="+filter.Topic))
	}
	if filter.Type != "" {
		parts = append(parts, activeStyle.Render("type="+filter.Type))
	}
	return strings.Join(parts, " ")
}

// InitChatViewport initializes a viewport for the chat panel.
func InitChatViewport(width, height int) viewport.Model {
	vp := viewport.New(width, height)
	vp.Style = lipgloss.NewStyle()
	return vp
}
