package main

import "github.com/charmbracelet/bubbles/key"

// InputMode tracks what input mode the TUI is in.
type InputMode int

const (
	ModeNormal  InputMode = iota
	ModeCommand           // : prefix command entry
	ModeFilter            // / filter entry
	ModeMessage           // m message entry
)

// KeyMap defines all key bindings for the TUI.
type KeyMap struct {
	// Global
	Quit       key.Binding
	Help       key.Binding
	CycleTheme key.Binding
	FilterMode key.Binding
	CmdMode    key.Binding
	MsgMode    key.Binding

	// Tab navigation
	NextTab key.Binding
	PrevTab key.Binding
	Tab1    key.Binding
	Tab2    key.Binding
	Tab3    key.Binding
	Tab4    key.Binding
	Tab5    key.Binding
	Tab6    key.Binding
	Tab7    key.Binding
	Tab8    key.Binding
	Tab9    key.Binding

	// Panel navigation
	Up       key.Binding
	Down     key.Binding
	Left     key.Binding
	Right    key.Binding
	Select   key.Binding
	Back     key.Binding
	Top      key.Binding
	Bottom   key.Binding
	HalfUp   key.Binding
	HalfDown key.Binding

	// Chat
	ToggleAutoScroll key.Binding

	// Agent control
	PauseAgent      key.Binding
	ResumeAgent     key.Binding
	DisconnectAgent key.Binding

	// Agent filtering/sorting
	GroupBy key.Binding
	SortBy  key.Binding

	// Launcher
	LaunchSwarm key.Binding
	CmdPalette  key.Binding
}

// DefaultKeyMap returns the default key bindings.
func DefaultKeyMap() KeyMap {
	return KeyMap{
		Quit: key.NewBinding(
			key.WithKeys("q", "ctrl+c"),
			key.WithHelp("q/ctrl+c", "quit"),
		),
		Help: key.NewBinding(
			key.WithKeys("?"),
			key.WithHelp("?", "toggle help"),
		),
		CycleTheme: key.NewBinding(
			key.WithKeys("t"),
			key.WithHelp("t", "cycle theme"),
		),
		FilterMode: key.NewBinding(
			key.WithKeys("/"),
			key.WithHelp("/", "filter mode"),
		),
		CmdMode: key.NewBinding(
			key.WithKeys(":"),
			key.WithHelp(":", "command mode"),
		),
		MsgMode: key.NewBinding(
			key.WithKeys("m"),
			key.WithHelp("m", "message mode"),
		),
		NextTab: key.NewBinding(
			key.WithKeys("tab"),
			key.WithHelp("tab", "next tab"),
		),
		PrevTab: key.NewBinding(
			key.WithKeys("shift+tab"),
			key.WithHelp("shift+tab", "prev tab"),
		),
		Tab1: key.NewBinding(
			key.WithKeys("1"),
			key.WithHelp("1", "overview"),
		),
		Tab2: key.NewBinding(
			key.WithKeys("2"),
			key.WithHelp("2", "agents"),
		),
		Tab3: key.NewBinding(
			key.WithKeys("3"),
			key.WithHelp("3", "chat"),
		),
		Tab4: key.NewBinding(
			key.WithKeys("4"),
			key.WithHelp("4", "hierarchy"),
		),
		Tab5: key.NewBinding(
			key.WithKeys("5"),
			key.WithHelp("5", "resources"),
		),
		Tab6: key.NewBinding(
			key.WithKeys("6"),
			key.WithHelp("6", "logs"),
		),
		Tab7: key.NewBinding(
			key.WithKeys("7"),
			key.WithHelp("7", "launcher"),
		),
		Tab8: key.NewBinding(
			key.WithKeys("8"),
			key.WithHelp("8", "internals"),
		),
		Tab9: key.NewBinding(
			key.WithKeys("9"),
			key.WithHelp("9", "network"),
		),
		Up: key.NewBinding(
			key.WithKeys("up", "k"),
			key.WithHelp("↑/k", "up"),
		),
		Down: key.NewBinding(
			key.WithKeys("down", "j"),
			key.WithHelp("↓/j", "down"),
		),
		Left: key.NewBinding(
			key.WithKeys("left", "h"),
			key.WithHelp("←/h", "collapse"),
		),
		Right: key.NewBinding(
			key.WithKeys("right", "l"),
			key.WithHelp("→/l", "expand"),
		),
		Select: key.NewBinding(
			key.WithKeys("enter"),
			key.WithHelp("enter", "select/expand"),
		),
		Back: key.NewBinding(
			key.WithKeys("esc"),
			key.WithHelp("esc", "back"),
		),
		Top: key.NewBinding(
			key.WithKeys("g"),
			key.WithHelp("g", "top"),
		),
		Bottom: key.NewBinding(
			key.WithKeys("G"),
			key.WithHelp("G", "bottom"),
		),
		HalfUp: key.NewBinding(
			key.WithKeys("ctrl+u"),
			key.WithHelp("ctrl+u", "half page up"),
		),
		HalfDown: key.NewBinding(
			key.WithKeys("ctrl+d"),
			key.WithHelp("ctrl+d", "half page down"),
		),
		ToggleAutoScroll: key.NewBinding(
			key.WithKeys("s"),
			key.WithHelp("s", "toggle auto-scroll"),
		),
		PauseAgent: key.NewBinding(
			key.WithKeys("p"),
			key.WithHelp("p", "pause agent"),
		),
		ResumeAgent: key.NewBinding(
			key.WithKeys("r"),
			key.WithHelp("r", "resume agent"),
		),
		DisconnectAgent: key.NewBinding(
			key.WithKeys("x"),
			key.WithHelp("x", "disconnect agent"),
		),
		GroupBy: key.NewBinding(
			key.WithKeys("ctrl+g"),
			key.WithHelp("ctrl+g", "cycle grouping"),
		),
		SortBy: key.NewBinding(
			key.WithKeys("ctrl+s"),
			key.WithHelp("ctrl+s", "cycle sorting"),
		),
		LaunchSwarm: key.NewBinding(
			key.WithKeys("L"),
			key.WithHelp("L", "launch swarm"),
		),
		CmdPalette: key.NewBinding(
			key.WithKeys("ctrl+p"),
			key.WithHelp("ctrl+p", "command palette"),
		),
	}
}

// ShortHelp returns a condensed list of key bindings for the help bar.
func (k KeyMap) ShortHelp() []key.Binding {
	return []key.Binding{
		k.NextTab, k.Up, k.Down, k.Select, k.Help, k.Quit,
	}
}

// FullHelp returns the complete set of key bindings grouped by category.
func (k KeyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Quit, k.Help, k.CycleTheme, k.FilterMode, k.CmdMode},
		{k.NextTab, k.PrevTab, k.Tab1, k.Tab2, k.Tab3, k.Tab4, k.Tab5, k.Tab6, k.Tab7, k.Tab8, k.Tab9},
		{k.Up, k.Down, k.Left, k.Right, k.Select, k.Back},
		{k.Top, k.Bottom, k.HalfUp, k.HalfDown, k.ToggleAutoScroll},
		{k.PauseAgent, k.ResumeAgent, k.DisconnectAgent, k.GroupBy, k.SortBy},
		{k.LaunchSwarm, k.CmdPalette},
	}
}
