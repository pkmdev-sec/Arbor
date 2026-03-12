package main

import (
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// NotifLevel represents notification severity.
type NotifLevel int

const (
	NotifInfo NotifLevel = iota
	NotifSuccess
	NotifWarning
	NotifError
)

// Notification represents a single toast notification.
type Notification struct {
	Level     NotifLevel
	Title     string
	Message   string
	CreatedAt time.Time
	Duration  time.Duration // auto-dismiss after this
}

// IsExpired returns true if the notification has exceeded its duration.
func (n Notification) IsExpired() bool {
	return time.Since(n.CreatedAt) > n.Duration
}

// NotificationManager manages the notification stack.
type NotificationManager struct {
	Notifications []Notification
	MaxVisible    int
}

// NewNotificationManager creates a new notification manager.
func NewNotificationManager() NotificationManager {
	return NotificationManager{
		Notifications: []Notification{},
		MaxVisible:    5,
	}
}

// Push adds a notification with default duration based on level.
func (nm *NotificationManager) Push(level NotifLevel, title, message string) {
	duration := 5 * time.Second
	if level == NotifWarning || level == NotifError {
		duration = 10 * time.Second
	}
	nm.PushTimed(level, title, message, duration)
}

// PushTimed adds a notification with a custom duration.
func (nm *NotificationManager) PushTimed(level NotifLevel, title, message string, duration time.Duration) {
	notif := Notification{
		Level:     level,
		Title:     title,
		Message:   message,
		CreatedAt: time.Now(),
		Duration:  duration,
	}
	nm.Notifications = append(nm.Notifications, notif)

	// Trim to max visible to avoid unbounded growth.
	if len(nm.Notifications) > nm.MaxVisible*2 {
		nm.Notifications = nm.Notifications[len(nm.Notifications)-nm.MaxVisible:]
	}
}

// Tick removes expired notifications.
func (nm *NotificationManager) Tick() {
	filtered := make([]Notification, 0, len(nm.Notifications))
	for _, n := range nm.Notifications {
		if !n.IsExpired() {
			filtered = append(filtered, n)
		}
	}
	nm.Notifications = filtered
}

// Dismiss removes a notification at the given index.
func (nm *NotificationManager) Dismiss(index int) {
	if index < 0 || index >= len(nm.Notifications) {
		return
	}
	nm.Notifications = append(nm.Notifications[:index], nm.Notifications[index+1:]...)
}

// Clear removes all notifications.
func (nm *NotificationManager) Clear() {
	nm.Notifications = []Notification{}
}

// RenderNotifications renders the notification stack as right-aligned toasts.
func RenderNotifications(nm NotificationManager, width int, theme Theme) string {
	if len(nm.Notifications) == 0 {
		return ""
	}

	// Show only the most recent MaxVisible notifications.
	start := 0
	if len(nm.Notifications) > nm.MaxVisible {
		start = len(nm.Notifications) - nm.MaxVisible
	}
	visible := nm.Notifications[start:]

	var toasts []string
	for _, notif := range visible {
		toast := renderNotification(notif, theme)
		toasts = append(toasts, toast)
	}

	stack := lipgloss.JoinVertical(lipgloss.Right, toasts...)

	// Align to the right side of the screen.
	return lipgloss.Place(width, lipgloss.Height(stack), lipgloss.Right, lipgloss.Top, stack)
}

// renderNotification renders a single notification as a bordered box.
func renderNotification(n Notification, theme Theme) string {
	var b strings.Builder

	// Icon and title
	icon := notifIcon(n.Level)
	iconStyle := lipgloss.NewStyle().Foreground(notifColor(n.Level, theme))
	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(theme.FG)

	b.WriteString(iconStyle.Render(icon))
	b.WriteString(" ")
	b.WriteString(titleStyle.Render(n.Title))
	b.WriteString("\n")

	// Message body
	if n.Message != "" {
		msgStyle := lipgloss.NewStyle().Foreground(theme.FG)
		b.WriteString(msgStyle.Render(n.Message))
	}

	content := b.String()

	// Box styling based on level
	borderColor := notifColor(n.Level, theme)
	boxStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(borderColor).
		Padding(0, 1).
		Width(30)

	return boxStyle.Render(content)
}

// notifIcon returns the icon string for a notification level.
func notifIcon(level NotifLevel) string {
	switch level {
	case NotifInfo:
		return "ℹ"
	case NotifSuccess:
		return "✓"
	case NotifWarning:
		return "⚠"
	case NotifError:
		return "✗"
	default:
		return "•"
	}
}

// notifColor returns the appropriate color for a notification level.
func notifColor(level NotifLevel, theme Theme) lipgloss.AdaptiveColor {
	switch level {
	case NotifInfo:
		return theme.Accent
	case NotifSuccess:
		return theme.Success
	case NotifWarning:
		return theme.Warning
	case NotifError:
		return theme.Error
	default:
		return theme.FG
	}
}
