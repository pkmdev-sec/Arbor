package main

import (
	"fmt"
	"runtime"
	"testing"
	"time"
)

func TestPollerMemory(t *testing.T) {
	var m1, m2 runtime.MemStats
	runtime.ReadMemStats(&m1)

	p := NewDataPoller(2 * time.Second)
	result := p.Poll()

	runtime.ReadMemStats(&m2)

	fmt.Printf("Agents: %d\n", len(result.Agents))
	fmt.Printf("Worktrees: %d\n", len(result.Worktrees))
	fmt.Printf("Alloc before: %d MB\n", m1.Alloc/1024/1024)
	fmt.Printf("Alloc after: %d MB\n", m2.Alloc/1024/1024)
	fmt.Printf("TotalAlloc: %d MB\n", m2.TotalAlloc/1024/1024)
	fmt.Printf("Sys: %d MB\n", m2.Sys/1024/1024)

	// Print first 5 agents
	for i, a := range result.Agents {
		if i >= 5 {
			break
		}
		fmt.Printf("  %s [%s] %s output=%d\n", a.Name, a.Model, a.Status, len(a.Output))
	}
}

func TestRenderOverview(t *testing.T) {
	var m1, m2 runtime.MemStats

	p := NewDataPoller(2 * time.Second)
	result := p.Poll()

	model := NewModel("", "dark", 2*time.Second)
	model.width = 200
	model.height = 50
	model.agents = result.Agents
	model.worktrees = result.Worktrees
	model.resources = result.Resources

	runtime.ReadMemStats(&m1)
	view := model.viewOverview(200, 40)
	runtime.ReadMemStats(&m2)

	fmt.Printf("Overview render: %d bytes, alloc delta: %d KB\n", len(view), (m2.Alloc-m1.Alloc)/1024)
}

func TestFullView(t *testing.T) {
	p := NewDataPoller(2 * time.Second)
	result := p.Poll()

	model := NewModel("", "dark", 2*time.Second)
	model.width = 200
	model.height = 50
	model.agents = result.Agents
	model.worktrees = result.Worktrees
	model.resources = result.Resources
	model.ipcEvents = result.IPCEvents
	model.hierarchy = BuildHierarchy(model.agents)

	var m runtime.MemStats

	// Test every tab
	tabs := []string{"overview", "agents", "chat", "hierarchy", "resources", "logs", "launcher", "internals", "network"}
	for i, name := range tabs {
		model.activeTab = i
		runtime.ReadMemStats(&m)
		before := m.Alloc
		view := model.View()
		runtime.ReadMemStats(&m)
		fmt.Printf("Tab %d (%s): %d bytes output, alloc delta: %d KB\n", i+1, name, len(view), (m.Alloc-before)/1024)
		if len(view) > 10*1024*1024 {
			t.Fatalf("Tab %s generated >10MB output: %d bytes", name, len(view))
		}
	}
}

func TestRenderAgents(t *testing.T) {
	var m1, m2 runtime.MemStats

	p := NewDataPoller(2 * time.Second)
	result := p.Poll()

	model := NewModel("", "dark", 2*time.Second)
	model.width = 200
	model.height = 50
	model.agents = result.Agents

	runtime.ReadMemStats(&m1)
	view := model.viewAgents(200, 40)
	runtime.ReadMemStats(&m2)

	fmt.Printf("Agents render: %d bytes, alloc delta: %d KB\n", len(view), (m2.Alloc-m1.Alloc)/1024)
}
