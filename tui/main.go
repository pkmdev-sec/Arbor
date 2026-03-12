package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// discoverBusSocket finds the most recent active IPC bus socket.
// Priority: 1) CLAUDE_IPC_SOCKET env var  2) newest /tmp/swarm/*/ipc-bus.sock
func discoverBusSocket() string {
	if envSock := os.Getenv("CLAUDE_IPC_SOCKET"); envSock != "" {
		if _, err := os.Stat(envSock); err == nil {
			return envSock
		}
	}

	matches, err := filepath.Glob("/tmp/swarm/*/ipc-bus.sock")
	if err != nil || len(matches) == 0 {
		return ""
	}

	// Sort by modification time descending — newest first
	sort.Slice(matches, func(i, j int) bool {
		si, _ := os.Stat(matches[i])
		sj, _ := os.Stat(matches[j])
		if si == nil || sj == nil {
			return false
		}
		return si.ModTime().After(sj.ModTime())
	})

	return matches[0]
}

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

	// Auto-discover bus socket if not explicitly provided
	effectiveBusAddr := *busAddr
	if effectiveBusAddr == "" {
		effectiveBusAddr = discoverBusSocket()
	}

	m := NewModel(effectiveBusAddr, *themeName, *pollInterval)
	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
