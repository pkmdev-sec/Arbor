package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	// Constrain Go runtime memory to prevent macOS OOM killer.
	// Set soft memory limit (128MB) and aggressive GC (collect at 50% heap growth).
	debug.SetMemoryLimit(128 * 1024 * 1024) // 128MB
	debug.SetGCPercent(50)
	runtime.GOMAXPROCS(2) // Limit CPU threads

	// Global panic recovery — write crash log before dying
	defer func() {
		if r := recover(); r != nil {
			crashLog := fmt.Sprintf("PANIC: %v\n\nStack:\n%s\n", r, debug.Stack())
			_ = os.WriteFile("/tmp/orch-tui-crash.log", []byte(crashLog), 0644)
			fmt.Fprintf(os.Stderr, "orch-tui crashed. See /tmp/orch-tui-crash.log\n")
			os.Exit(1)
		}
	}()

	busAddr := flag.String("bus-address", "", "IPC bus Unix socket path")
	themeName := flag.String("theme", "dark", "Color theme (dark, catppuccin, dracula, neon)")
	pollInterval := flag.Duration("poll-interval", 2*time.Second, "Data polling interval")
	flag.Parse()

	m := NewModel(*busAddr, *themeName, *pollInterval)
	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
