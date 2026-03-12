package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Tab indices.
const (
	tabOverview = iota
	tabAgents
	tabChat
	tabHierarchy
	tabResources
	tabLogs
	tabLauncher
	tabInternals
	tabNetwork
	tabCount
)

var tabNames = [tabCount]string{
	"Overview", "Agents", "Chat", "Hierarchy", "Resources", "Logs", "Launch", "Intern", "Net",
}

// Model is the top-level Bubble Tea model for the orchestration TUI.
type Model struct {
	width  int
	height int

	theme     Theme
	themeName string
	keys      KeyMap
	inputMode InputMode
	showHelp  bool

	activeTab     int
	selectedAgent int
	selectedLog      int // selected entry in Logs tab
	selectedInternal int // selected entry in Internals tab
	selectedNet      int // selected entry in Network tab

	// Agent filtering and grouping
	agentFilter   string // search/filter string
	agentGroupBy  string // "", "status", "model", "run"
	agentSortBy   string // "name", "elapsed", "status", "model"

	ipc          *IPCConn
	busAddress   string
	ipcConnected bool

	messages     *MessageRing
	chatFilter   ChatFilter
	chatViewport viewport.Model
	autoScroll   bool

	hierarchy    *TreeNode
	hierarchyIdx int

	agents    []Agent
	worktrees []WorktreeInfo
	resources ResourceSnapshot
	poller    *DataPoller
	ipcEvents []IPCEvent

	confirmDialog ConfirmDialog
	launcher      LauncherModel

	lastError  string
	startTime  time.Time
	lastPoll   time.Time
	isPolling  bool
}

// NewModel creates the initial model from CLI flags.
func NewModel(busAddress, themeName string, pollInterval time.Duration) Model {
	m := Model{
		theme:        GetTheme(themeName),
		themeName:    themeName,
		keys:         DefaultKeyMap(),
		inputMode:    ModeNormal,
		busAddress:   busAddress,
		messages:     NewMessageRing(maxMessages),
		autoScroll:   true,
		poller:       NewDataPoller(pollInterval),
		chatViewport: InitChatViewport(80, 24),
		launcher:     NewLauncherModel(),
		agentSortBy:  "name",
		agentGroupBy: "",
		startTime:    time.Now(),
	}
	if busAddress != "" {
		m.ipc = NewIPCConn(busAddress)
	}
	return m
}

// Init starts the poller and optionally connects to the IPC bus.
func (m Model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.poller.PollTick()}
	if m.ipc != nil {
		ipc := m.ipc
		cmds = append(cmds, func() tea.Msg {
			if err := ipc.Connect(); err != nil {
				return ipcErrMsg{err: err}
			}
			return ipcConnectedMsg{}
		})
	}
	return tea.Batch(cmds...)
}

// Update handles all incoming messages.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		vpH := m.height - 3 // tab bar + status bar + filter bar
		if vpH < 1 {
			vpH = 1
		}
		m.chatViewport.Width = m.width
		m.chatViewport.Height = vpH
		// Re-render chat content at new width.
		content := RenderChatPanel(m.messages.All(), m.chatFilter, m.width, m.theme)
		m.chatViewport.SetContent(content)
		return m, nil

	case tea.KeyMsg:
		// Handle confirm dialog first if visible
		if m.confirmDialog.Visible {
			switch msg.String() {
			case "y", "Y":
				if m.confirmDialog.OnYes != nil {
					m.confirmDialog.OnYes()
				}
				m.confirmDialog.Hide()
				return m, nil
			case "n", "N", "esc":
				if m.confirmDialog.OnNo != nil {
					m.confirmDialog.OnNo()
				}
				m.confirmDialog.Hide()
				return m, nil
			}
			return m, nil
		}

		if m.inputMode != ModeNormal {
			if key.Matches(msg, m.keys.Back) {
				m.inputMode = ModeNormal
			}
			return m, nil
		}
		return m.handleNormalKey(msg)

	case launchSuccessMsg, launchErrMsg:
		// Forward to launcher
		var cmd tea.Cmd
		m.launcher, cmd = m.launcher.Update(msg)
		return m, cmd

	case ipcConnectedMsg:
		m.ipcConnected = true
		m.lastError = ""
		if m.ipc != nil {
			return m, listenForIPCMessages(m.ipc)
		}
		return m, nil

	case ipcMsg:
		m.messages.Push(msg.msg)
		if m.autoScroll {
			content := RenderChatPanel(m.messages.All(), m.chatFilter, m.width, m.theme)
			m.chatViewport.SetContent(content)
			m.chatViewport.GotoBottom()
		}
		if m.ipc != nil {
			return m, listenForIPCMessages(m.ipc)
		}
		return m, nil

	case ipcErrMsg:
		m.ipcConnected = false
		m.lastError = msg.err.Error()
		return m, nil

	case ipcDisconnectedMsg:
		m.ipcConnected = false
		return m, nil

	case pollTickMsg:
		m.isPolling = true
		m.lastPoll = time.Now()
		// Only update if poll returned data (background poll may not be ready)
		if len(msg.result.Agents) > 0 || len(m.agents) == 0 {
			m.agents = msg.result.Agents
			m.worktrees = msg.result.Worktrees
			m.resources = msg.result.Resources
			m.ipcEvents = msg.result.IPCEvents
			m.hierarchy = BuildHierarchy(m.agents)
			if m.selectedAgent >= len(m.agents) {
				m.selectedAgent = max(0, len(m.agents)-1)
			}
		}
		m.isPolling = false
		return m, m.poller.PollTick()
	}

	// Forward viewport messages when on the chat tab.
	if m.activeTab == tabChat {
		var cmd tea.Cmd
		m.chatViewport, cmd = m.chatViewport.Update(msg)
		return m, cmd
	}

	// Forward messages to launcher when on launcher tab.
	if m.activeTab == tabLauncher {
		var cmd tea.Cmd
		m.launcher, cmd = m.launcher.Update(msg)
		return m, cmd
	}

	return m, nil
}

// --- Key Handling ---

func (m Model) handleNormalKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Quit):
		if m.ipc != nil {
			m.ipc.Close()
		}
		return m, tea.Quit
	case key.Matches(msg, m.keys.Help):
		m.showHelp = !m.showHelp
		return m, nil
	case key.Matches(msg, m.keys.CycleTheme):
		m.themeName = CycleTheme(m.themeName)
		m.theme = GetTheme(m.themeName)
		return m, nil

	// Tab switching
	case key.Matches(msg, m.keys.NextTab):
		m.activeTab = (m.activeTab + 1) % tabCount
		return m, nil
	case key.Matches(msg, m.keys.PrevTab):
		m.activeTab = (m.activeTab - 1 + tabCount) % tabCount
		return m, nil
	case key.Matches(msg, m.keys.Tab1):
		m.activeTab = tabOverview
		return m, nil
	case key.Matches(msg, m.keys.Tab2):
		m.activeTab = tabAgents
		return m, nil
	case key.Matches(msg, m.keys.Tab3):
		m.activeTab = tabChat
		return m, nil
	case key.Matches(msg, m.keys.Tab4):
		m.activeTab = tabHierarchy
		return m, nil
	case key.Matches(msg, m.keys.Tab5):
		m.activeTab = tabResources
		return m, nil
	case key.Matches(msg, m.keys.Tab6):
		m.activeTab = tabLogs
		return m, nil
	case key.Matches(msg, m.keys.Tab7):
		m.activeTab = tabLauncher
		return m, nil
	case key.Matches(msg, m.keys.Tab8):
		m.activeTab = tabInternals
		return m, nil
	case key.Matches(msg, m.keys.Tab9):
		m.activeTab = tabNetwork
		return m, nil
	case key.Matches(msg, m.keys.LaunchSwarm):
		m.activeTab = tabLauncher
		return m, nil

	// Input mode entry
	case key.Matches(msg, m.keys.FilterMode):
		m.inputMode = ModeFilter
		return m, nil
	case key.Matches(msg, m.keys.CmdMode):
		m.inputMode = ModeCommand
		return m, nil
	case key.Matches(msg, m.keys.MsgMode):
		m.inputMode = ModeMessage
		return m, nil
	}

	// Tab-specific keys
	switch m.activeTab {
	case tabAgents:
		m = m.handleAgentKeys(msg)
	case tabChat:
		return m.handleChatKeys(msg)
	case tabHierarchy:
		m = m.handleHierarchyKeys(msg)
	case tabLogs:
		m = m.handleLogKeys(msg)
	case tabInternals:
		m = m.handleInternalKeys(msg)
	case tabNetwork:
		m = m.handleNetworkKeys(msg)
	}
	return m, nil
}

func (m Model) handleAgentKeys(msg tea.KeyMsg) Model {
	switch {
	case key.Matches(msg, m.keys.Up):
		if m.selectedAgent > 0 {
			m.selectedAgent--
		}
	case key.Matches(msg, m.keys.Down):
		if m.selectedAgent < len(m.agents)-1 {
			m.selectedAgent++
		}
	case key.Matches(msg, m.keys.Top):
		m.selectedAgent = 0
	case key.Matches(msg, m.keys.Bottom):
		if len(m.agents) > 0 {
			m.selectedAgent = len(m.agents) - 1
		}
	case key.Matches(msg, m.keys.HalfUp):
		m.selectedAgent -= 10
		if m.selectedAgent < 0 {
			m.selectedAgent = 0
		}
	case key.Matches(msg, m.keys.HalfDown):
		m.selectedAgent += 10
		if m.selectedAgent >= len(m.agents) {
			m.selectedAgent = max(0, len(m.agents)-1)
		}
	case key.Matches(msg, m.keys.GroupBy):
		// Cycle through: "" → "status" → "model" → "run" → ""
		switch m.agentGroupBy {
		case "":
			m.agentGroupBy = "status"
		case "status":
			m.agentGroupBy = "model"
		case "model":
			m.agentGroupBy = "run"
		case "run":
			m.agentGroupBy = ""
		}
	case key.Matches(msg, m.keys.SortBy):
		// Cycle through: "name" → "elapsed" → "status" → "model" → "name"
		switch m.agentSortBy {
		case "name":
			m.agentSortBy = "elapsed"
		case "elapsed":
			m.agentSortBy = "status"
		case "status":
			m.agentSortBy = "model"
		case "model":
			m.agentSortBy = "name"
		default:
			m.agentSortBy = "name"
		}
	case key.Matches(msg, m.keys.PauseAgent):
		if m.selectedAgent >= 0 && m.selectedAgent < len(m.agents) && m.ipc != nil {
			agentID := m.agents[m.selectedAgent].ID
			m.confirmDialog = NewConfirmDialog(
				"Pause Agent",
				fmt.Sprintf("Pause agent %s?", agentID),
				func() {
					if err := m.ipc.PauseAgent(agentID); err != nil {
						m.lastError = fmt.Sprintf("pause failed: %v", err)
					}
				},
				nil,
			)
		}
	case key.Matches(msg, m.keys.ResumeAgent):
		if m.selectedAgent >= 0 && m.selectedAgent < len(m.agents) && m.ipc != nil {
			agentID := m.agents[m.selectedAgent].ID
			if err := m.ipc.ResumeAgent(agentID); err != nil {
				m.lastError = fmt.Sprintf("resume failed: %v", err)
			}
		}
	case key.Matches(msg, m.keys.DisconnectAgent):
		if m.selectedAgent >= 0 && m.selectedAgent < len(m.agents) && m.ipc != nil {
			agentID := m.agents[m.selectedAgent].ID
			m.confirmDialog = NewConfirmDialog(
				"Disconnect Agent",
				fmt.Sprintf("Disconnect agent %s?", agentID),
				func() {
					if err := m.ipc.DisconnectAgent(agentID); err != nil {
						m.lastError = fmt.Sprintf("disconnect failed: %v", err)
					}
				},
				nil,
			)
		}
	}
	return m
}

func (m Model) handleChatKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.ToggleAutoScroll):
		m.autoScroll = !m.autoScroll
		return m, nil
	case key.Matches(msg, m.keys.Top):
		m.chatViewport.GotoTop()
		return m, nil
	case key.Matches(msg, m.keys.Bottom):
		m.chatViewport.GotoBottom()
		return m, nil
	}
	var cmd tea.Cmd
	m.chatViewport, cmd = m.chatViewport.Update(msg)
	return m, cmd
}

func (m Model) handleHierarchyKeys(msg tea.KeyMsg) Model {
	switch {
	case key.Matches(msg, m.keys.Up):
		if m.hierarchyIdx > 0 {
			m.hierarchyIdx--
		}
	case key.Matches(msg, m.keys.Down):
		if m.hierarchy != nil {
			visible := m.hierarchy.FlattenVisible()
			if m.hierarchyIdx < len(visible)-1 {
				m.hierarchyIdx++
			}
		}
	case key.Matches(msg, m.keys.Select), key.Matches(msg, m.keys.Right):
		if m.hierarchy != nil {
			visible := m.hierarchy.FlattenVisible()
			if m.hierarchyIdx >= 0 && m.hierarchyIdx < len(visible) {
				visible[m.hierarchyIdx].ToggleExpand()
			}
		}
	case key.Matches(msg, m.keys.Left):
		if m.hierarchy != nil {
			visible := m.hierarchy.FlattenVisible()
			if m.hierarchyIdx >= 0 && m.hierarchyIdx < len(visible) && visible[m.hierarchyIdx].Expanded {
				visible[m.hierarchyIdx].ToggleExpand()
			}
		}
	case key.Matches(msg, m.keys.Top):
		m.hierarchyIdx = 0
	case key.Matches(msg, m.keys.Bottom):
		if m.hierarchy != nil {
			visible := m.hierarchy.FlattenVisible()
			m.hierarchyIdx = max(0, len(visible)-1)
		}
	}
	return m
}

// --- View ---

func (m Model) View() string {
	// Recover from any render panics to prevent TUI crash
	defer func() {
		if r := recover(); r != nil {
			// Silently recover — next render will succeed
		}
	}()

	if m.width == 0 {
		return "  Initializing..."
	}

	header := m.viewTabBar()
	status := m.viewStatusBar()

	contentH := m.height - lipgloss.Height(header) - lipgloss.Height(status)
	if contentH < 1 {
		contentH = 1
	}

	var content string
	if m.showHelp {
		content = m.viewHelp(m.width, contentH)
	} else {
		content = m.viewContent(m.width, contentH)
	}
	content = lipgloss.Place(m.width, contentH, lipgloss.Left, lipgloss.Top, content)

	// Apply confirm dialog overlay if visible
	if m.confirmDialog.Visible {
		content = RenderConfirmOverlay(content, m.confirmDialog, m.width, contentH, m.theme)
	}

	return lipgloss.JoinVertical(lipgloss.Left, header, content, status)
}

func (m Model) viewTabBar() string {
	var tabs []string

	// Calculate badge counts
	failedCount := 0
	for _, a := range m.agents {
		if a.Status == "failed" {
			failedCount++
		}
	}
	unreadMsgs := 0
	// Track unread as messages since last view (simplified: just show total if > 0)
	if m.activeTab != tabChat && m.messages.Len() > 0 {
		unreadMsgs = m.messages.Len()
	}

	for i := 0; i < tabCount; i++ {
		badge := ""
		badgeColor := m.theme.Error

		// Add badges for specific tabs
		if i == tabAgents && failedCount > 0 {
			badge = fmt.Sprintf(" %d✗", failedCount)
			badgeColor = m.theme.Error
		} else if i == tabChat && unreadMsgs > 0 && m.activeTab != tabChat {
			badge = fmt.Sprintf(" %d", unreadMsgs)
			badgeColor = m.theme.Accent
		}

		label := fmt.Sprintf(" %d:%s%s ", i+1, tabNames[i], badge)
		if i == m.activeTab {
			// Active tab: solid background + bold
			tabs = append(tabs, lipgloss.NewStyle().
				Bold(true).
				Foreground(m.theme.BG).
				Background(m.theme.Accent).
				Render(label))
		} else {
			style := lipgloss.NewStyle().Foreground(m.theme.Muted)
			if badge != "" {
				// Inactive tab with badge: brighter text
				badgeStyle := lipgloss.NewStyle().
					Foreground(badgeColor).
					Bold(true)
				labelWithoutBadge := fmt.Sprintf(" %d:%s", i+1, tabNames[i])
				renderedTab := style.Render(labelWithoutBadge) + badgeStyle.Render(badge) + " "
				tabs = append(tabs, renderedTab)
			} else {
				tabs = append(tabs, style.Render(label))
			}
		}
	}
	bar := strings.Join(tabs, lipgloss.NewStyle().Foreground(m.theme.Border).Render("│"))

	// Add bottom border under tab bar
	divider := lipgloss.NewStyle().
		Foreground(m.theme.Border).
		Width(m.width).
		Render(strings.Repeat("─", m.width))

	return lipgloss.JoinVertical(lipgloss.Left, bar, divider)
}

func (m Model) viewContent(width, height int) string {
	switch m.activeTab {
	case tabOverview:
		return m.viewOverview(width, height)
	case tabAgents:
		return m.viewAgents(width, height)
	case tabChat:
		return m.viewChat(width, height)
	case tabHierarchy:
		return m.viewHierarchy(width, height)
	case tabResources:
		return m.viewResources(width, height)
	case tabLogs:
		return m.viewLogs(width, height)
	case tabLauncher:
		return m.launcher.View(width, height, m.theme)
	case tabInternals:
		return RenderInternalsPanel(m.agents, m.ipcEvents, m.selectedInternal, width, height, m.theme)
	case tabNetwork:
		return RenderNetworkPanel(m.messages.All(), m.ipcEvents, m.agents, m.resources, m.ipcConnected, m.selectedNet, width, height, m.theme)
	default:
		return ""
	}
}

func (m Model) viewStatusBar() string {
	// Background color for status bar
	statusBg := lipgloss.AdaptiveColor{Light: "#e8e8e8", Dark: "#1a1a1a"}
	muted := lipgloss.NewStyle().Foreground(m.theme.Muted)
	accent := lipgloss.NewStyle().Foreground(m.theme.Accent)

	var parts []string

	// Current tab
	parts = append(parts, accent.Render(tabNames[m.activeTab]))

	// Uptime
	uptime := time.Since(m.startTime)
	uptimeStr := fmt.Sprintf("up:%s", FormatElapsed(uptime))
	parts = append(parts, muted.Render(uptimeStr))

	// Poll indicator
	pollIcon := "○"
	if m.isPolling {
		pollIcon = "●"
	}
	pollStr := fmt.Sprintf("%s poll", pollIcon)
	if !m.lastPoll.IsZero() {
		timeSincePoll := time.Since(m.lastPoll)
		if timeSincePoll < 5*time.Second {
			pollStr = fmt.Sprintf("%s %s", lipgloss.NewStyle().Foreground(m.theme.Success).Render(pollIcon), muted.Render("poll"))
		} else {
			pollStr = fmt.Sprintf("%s %s", muted.Render(pollIcon), muted.Render("poll"))
		}
	}
	parts = append(parts, pollStr)

	// IPC status
	if m.ipc != nil {
		if m.ipcConnected {
			parts = append(parts, lipgloss.NewStyle().Foreground(m.theme.Success).Render("● IPC"))
		} else {
			parts = append(parts, lipgloss.NewStyle().Foreground(m.theme.Error).Render("✗ IPC"))
		}
	} else {
		parts = append(parts, muted.Render("○ IPC"))
	}

	// Agent count
	running := 0
	for _, a := range m.agents {
		if a.Status == "running" {
			running++
		}
	}
	parts = append(parts, accent.Render(fmt.Sprintf("%d agents (%d active)", len(m.agents), running)))

	// Scroll position for Agents tab
	if m.activeTab == tabAgents && len(m.agents) > 0 {
		parts = append(parts, muted.Render(fmt.Sprintf("sel:%d/%d", m.selectedAgent+1, len(m.agents))))
	}

	// Messages
	if m.messages.Len() > 0 {
		parts = append(parts, muted.Render(fmt.Sprintf("%d msgs", m.messages.Len())))
	}

	// Theme
	parts = append(parts, muted.Render(m.themeName))

	// Auto-scroll indicator
	if m.activeTab == tabChat {
		if m.autoScroll {
			parts = append(parts, lipgloss.NewStyle().Foreground(m.theme.Success).Render("auto-scroll"))
		} else {
			parts = append(parts, muted.Render("scroll:manual"))
		}
	}

	// Keyboard hints
	parts = append(parts, muted.Render("Tab/Shift+Tab:switch"))
	parts = append(parts, muted.Render("?:help"))

	// Error
	if m.lastError != "" {
		errStr := m.lastError
		if len(errStr) > 40 {
			errStr = errStr[:37] + "..."
		}
		parts = append(parts, lipgloss.NewStyle().Foreground(m.theme.Error).Render(errStr))
	}

	bar := " " + strings.Join(parts, muted.Render(" │ "))
	return lipgloss.NewStyle().
		Width(m.width).
		Background(statusBg).
		Render(bar)
}

// --- Tab Views ---

func (m Model) viewOverview(width, height int) string {
	// Calculate box widths for grid layout
	halfW := (width - 3) / 2 // Account for spacing
	if halfW < 20 {
		halfW = 20
	}

	// Agent summary
	var running, done, failed, spawning, timeout int
	var totalTools, totalCost float64
	var totalTokensIn, totalTokensOut int
	for _, a := range m.agents {
		switch a.Status {
		case "running":
			running++
		case "done":
			done++
		case "failed":
			failed++
		case "spawning":
			spawning++
		case "timeout":
			timeout++
		}
		totalTools += float64(a.ToolCalls)
		totalCost += a.Cost
		totalTokensIn += a.TokensIn
		totalTokensOut += a.TokensOut
	}

	// Top row: Agent Summary + Current Run boxes
	agentSummaryBox := m.renderAgentSummaryBox(running, done, failed, spawning, timeout, halfW)
	currentRunBox := m.renderCurrentRunBox(halfW)
	topRow := lipgloss.JoinHorizontal(lipgloss.Top, agentSummaryBox, " ", currentRunBox)

	// Resource Gauges box (full width)
	resourceBox := m.renderResourceGaugesBox(width)

	// Active Agents box
	activeAgentsBox := m.renderActiveAgentsBox(running, spawning, width)

	// Recent Events box
	recentEventsBox := m.renderRecentEventsBox(done, failed, width)

	// Join all sections vertically
	return lipgloss.JoinVertical(lipgloss.Left,
		topRow,
		"",
		resourceBox,
		"",
		activeAgentsBox,
		"",
		recentEventsBox,
	)
}

func (m Model) renderAgentSummaryBox(running, done, failed, spawning, timeout, width int) string {
	var b strings.Builder
	muted := lipgloss.NewStyle().Foreground(m.theme.Muted)

	if running > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(m.theme.Success).
			Render(fmt.Sprintf("● %d running", running)))
		b.WriteString("\n")
	}
	if spawning > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(m.theme.Warning).
			Render(fmt.Sprintf("◔ %d spawning", spawning)))
		b.WriteString("\n")
	}
	if done > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(m.theme.Success).
			Render(fmt.Sprintf("✓ %d done", done)))
		b.WriteString("\n")
	}
	if failed > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(m.theme.Error).
			Render(fmt.Sprintf("✗ %d failed", failed)))
		b.WriteString("\n")
	}
	if timeout > 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(m.theme.Warning).
			Render(fmt.Sprintf("⏱ %d timeout", timeout)))
		b.WriteString("\n")
	}
	if b.Len() == 0 {
		b.WriteString(muted.Render("No agents\n"))
	}
	b.WriteString("\n")
	b.WriteString(muted.Render(fmt.Sprintf("Total: %d", len(m.agents))))

	content := lipgloss.NewStyle().Padding(0, 1).Render(b.String())

	// Panel with title in the border
	panel := m.theme.PanelStyle.Copy().
		Width(width).
		BorderTop(true).
		BorderBottom(true).
		BorderLeft(true).
		BorderRight(true)

	titleStyle := m.theme.PanelTitle.Copy().
		Width(width - 4).
		Align(lipgloss.Left).
		PaddingLeft(1)

	fullContent := lipgloss.JoinVertical(lipgloss.Left, titleStyle.Render("Agent Summary"), content)

	return panel.Render(fullContent)
}

func (m Model) renderCurrentRunBox(width int) string {
	var b strings.Builder
	muted := lipgloss.NewStyle().Foreground(m.theme.Muted)

	// Try to detect current run from agents
	runID := "N/A"
	runMode := "polling"
	for _, a := range m.agents {
		if a.RunDir != "" {
			runID = a.RunDir
			if len(runID) > 8 {
				runID = runID[:8]
			}
			break
		}
	}

	b.WriteString(fmt.Sprintf("Run: %s\n", runID))
	b.WriteString(muted.Render(fmt.Sprintf("Mode: %s\n", runMode)))
	if m.ipc != nil {
		if m.ipcConnected {
			b.WriteString(lipgloss.NewStyle().Foreground(m.theme.Success).Render("● IPC Connected\n"))
		} else {
			b.WriteString(lipgloss.NewStyle().Foreground(m.theme.Error).Render("✗ IPC Disconnected\n"))
		}
	} else {
		b.WriteString(muted.Render("○ IPC Disabled\n"))
	}
	b.WriteString("\n")
	b.WriteString(muted.Render(fmt.Sprintf("Messages: %d", m.messages.Len())))

	content := lipgloss.NewStyle().Padding(0, 1).Render(b.String())

	panel := m.theme.PanelStyle.Copy().
		Width(width).
		BorderTop(true).
		BorderBottom(true).
		BorderLeft(true).
		BorderRight(true)

	titleStyle := m.theme.PanelTitle.Copy().
		Width(width - 4).
		Align(lipgloss.Left).
		PaddingLeft(1)

	fullContent := lipgloss.JoinVertical(lipgloss.Left, titleStyle.Render("Current Run"), content)

	return panel.Render(fullContent)
}

func (m Model) renderResourceGaugesBox(width int) string {
	var b strings.Builder
	muted := lipgloss.NewStyle().Foreground(m.theme.Muted)

	// Agent gauge with actual numbers
	b.WriteString(Gauge("Agents", float64(m.resources.ActiveAgents), float64(m.resources.MaxAgents), width-8, m.theme))
	b.WriteString(muted.Render(fmt.Sprintf(" %d/%d", m.resources.ActiveAgents, m.resources.MaxAgents)))
	b.WriteString("\n")

	// Cost gauge with actual numbers
	b.WriteString(Gauge("Cost", m.resources.EstimatedCost, m.resources.CostBudget, width-8, m.theme))
	b.WriteString(muted.Render(fmt.Sprintf(" $%.2f/$%.2f", m.resources.EstimatedCost, m.resources.CostBudget)))
	b.WriteString("\n")

	// Memory gauge with actual numbers
	b.WriteString(Gauge("Memory", m.resources.MemoryMB, m.resources.MaxMemoryMB, width-8, m.theme))
	b.WriteString(muted.Render(fmt.Sprintf(" %.0fMB/%.0fMB", m.resources.MemoryMB, m.resources.MaxMemoryMB)))

	content := lipgloss.NewStyle().Padding(0, 1).Render(b.String())

	panel := m.theme.PanelStyle.Copy().
		Width(width).
		BorderTop(true).
		BorderBottom(true).
		BorderLeft(true).
		BorderRight(true)

	titleStyle := m.theme.PanelTitle.Copy().
		Width(width - 4).
		Align(lipgloss.Left).
		PaddingLeft(1)

	fullContent := lipgloss.JoinVertical(lipgloss.Left, titleStyle.Render("Resource Gauges"), content)

	return panel.Render(fullContent)
}

func (m Model) renderActiveAgentsBox(running, spawning, width int) string {
	var b strings.Builder
	muted := lipgloss.NewStyle().Foreground(m.theme.Muted)

	activeShown := 0
	for _, a := range m.agents {
		if a.Status == "running" || a.Status == "spawning" {
			// Compact one-line format for overview
			statusClr := m.theme.StatusColor(a.Status)
			statusIcon := m.theme.StatusIcon(a.Status)
			name := a.Name
			if name == "" {
				name = a.ID
			}
			if len(name) > 15 {
				name = name[:12] + "..."
			}
			model := a.Model
			if model == "" {
				model = "?"
			}
			elapsed := FormatElapsed(a.ElapsedTime())
			task := a.TaskDesc
			maxTaskLen := width - 40
			if maxTaskLen < 20 {
				maxTaskLen = 20
			}
			if len(task) > maxTaskLen {
				task = task[:maxTaskLen-3] + "..."
			}

			b.WriteString(fmt.Sprintf("%s %s [%s] %s %s\n",
				lipgloss.NewStyle().Foreground(statusClr).Render(statusIcon),
				name,
				model,
				muted.Render(elapsed),
				task,
			))
			activeShown++
			if activeShown >= 5 {
				remaining := running + spawning - activeShown
				if remaining > 0 {
					b.WriteString("\n")
					b.WriteString(muted.Render(fmt.Sprintf("... and %d more", remaining)))
				}
				break
			}
		}
	}

	if activeShown == 0 {
		b.WriteString(muted.Render("No active agents"))
	}

	content := lipgloss.NewStyle().Padding(0, 1).Render(b.String())

	panel := m.theme.PanelStyle.Copy().
		Width(width).
		BorderTop(true).
		BorderBottom(true).
		BorderLeft(true).
		BorderRight(true)

	titleStyle := m.theme.PanelTitle.Copy().
		Width(width - 4).
		Align(lipgloss.Left).
		PaddingLeft(1)

	fullContent := lipgloss.JoinVertical(lipgloss.Left, titleStyle.Render("Active Agents"), content)

	return panel.Render(fullContent)
}

func (m Model) renderRecentEventsBox(done, failed, width int) string {
	var b strings.Builder
	muted := lipgloss.NewStyle().Foreground(m.theme.Muted)

	// Show last 5 completed agents
	var recentComplete []Agent
	for i := len(m.agents) - 1; i >= 0 && len(recentComplete) < 5; i-- {
		if m.agents[i].Status == "done" || m.agents[i].Status == "failed" {
			recentComplete = append(recentComplete, m.agents[i])
		}
	}

	if len(recentComplete) > 0 {
		for _, a := range recentComplete {
			statusClr := m.theme.StatusColor(a.Status)
			statusIcon := m.theme.StatusIcon(a.Status)
			name := a.Name
			if name == "" {
				name = a.ID
			}
			if len(name) > 15 {
				name = name[:12] + "..."
			}
			elapsed := FormatElapsed(a.ElapsedTime())

			// Show timestamp from EndTime if available
			timeStr := "now"
			if !a.EndTime.IsZero() {
				timeStr = a.EndTime.Format("15:04:05")
			}

			b.WriteString(fmt.Sprintf("%s %s %-15s %s\n",
				muted.Render(timeStr),
				lipgloss.NewStyle().Foreground(statusClr).Render(statusIcon),
				name,
				muted.Render(elapsed),
			))
		}
	} else {
		b.WriteString(muted.Render("No completed agents yet"))
	}

	content := lipgloss.NewStyle().Padding(0, 1).Render(b.String())

	panel := m.theme.PanelStyle.Copy().
		Width(width).
		BorderTop(true).
		BorderBottom(true).
		BorderLeft(true).
		BorderRight(true)

	titleStyle := m.theme.PanelTitle.Copy().
		Width(width - 4).
		Align(lipgloss.Left).
		PaddingLeft(1)

	fullContent := lipgloss.JoinVertical(lipgloss.Left, titleStyle.Render("Recent Events"), content)

	return panel.Render(fullContent)
}

func (m Model) viewAgents(width, height int) string {
	if len(m.agents) == 0 {
		return lipgloss.NewStyle().Foreground(m.theme.Muted).
			Render("  No agents discovered")
	}

	listW := width * 35 / 100
	if listW < 30 {
		listW = 30
	}
	detailW := width - listW - 3

	// Apply sorting
	sortedAgents := make([]Agent, len(m.agents))
	copy(sortedAgents, m.agents)
	SortAgents(sortedAgents, m.agentSortBy)

	// Apply grouping
	groups := GroupAgents(sortedAgents, m.agentGroupBy)

	// Flatten groups with headers
	var flatList []string
	mutedStyle := lipgloss.NewStyle().Foreground(m.theme.Muted)
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Accent)

	totalCount := 0
	if m.agentGroupBy != "" {
		// Render groups with headers
		groupOrder := []string{}
		for groupName := range groups {
			groupOrder = append(groupOrder, groupName)
		}
		// Sort group names
		for i := 0; i < len(groupOrder); i++ {
			for j := i + 1; j < len(groupOrder); j++ {
				if groupOrder[i] > groupOrder[j] {
					groupOrder[i], groupOrder[j] = groupOrder[j], groupOrder[i]
				}
			}
		}

		for _, groupName := range groupOrder {
			agents := groups[groupName]
			if len(agents) == 0 {
				continue
			}
			// Group header
			flatList = append(flatList, headerStyle.Render(fmt.Sprintf("─── %s (%d) ───", groupName, len(agents))))
			for _, a := range agents {
				flatList = append(flatList, RenderAgentCard(a, totalCount == m.selectedAgent, listW-2, m.theme))
				totalCount++
			}
			flatList = append(flatList, "") // Spacer
		}
	} else {
		// No grouping, flat list
		for i, a := range sortedAgents {
			flatList = append(flatList, RenderAgentCard(a, i == m.selectedAgent, listW-2, m.theme))
		}
		totalCount = len(sortedAgents)
	}

	// Agent list with scrolling support
	visibleHeight := height - 4 // Account for panel borders + metadata
	if visibleHeight < 1 {
		visibleHeight = 1
	}

	// Calculate scroll window
	startIdx := m.selectedAgent - visibleHeight/2
	if startIdx < 0 {
		startIdx = 0
	}
	endIdx := startIdx + visibleHeight
	if endIdx > len(flatList) {
		endIdx = len(flatList)
		startIdx = max(0, endIdx-visibleHeight)
	}

	visibleLines := flatList[startIdx:endIdx]

	// Add scroll indicator if needed
	if len(flatList) > visibleHeight {
		if startIdx > 0 {
			visibleLines = append([]string{mutedStyle.Render(fmt.Sprintf("  ▲ %d more above", startIdx))}, visibleLines...)
		}
		remaining := len(flatList) - endIdx
		if remaining > 0 {
			visibleLines = append(visibleLines, mutedStyle.Render(fmt.Sprintf("  ▼ %d more below", remaining)))
		}
	}

	// Add metadata footer
	metadata := mutedStyle.Render(fmt.Sprintf("Sort:%s | Group:%s | %d/%d",
		m.agentSortBy,
		func() string { if m.agentGroupBy == "" { return "none" }; return m.agentGroupBy }(),
		m.selectedAgent+1,
		totalCount,
	))
	visibleLines = append(visibleLines, "", metadata)

	list := strings.Join(visibleLines, "\n")

	// Selected agent detail — bounds-check against sortedAgents to prevent panic
	var detail string
	sel := m.selectedAgent
	if sel < 0 {
		sel = 0
	}
	if sel >= len(sortedAgents) {
		sel = len(sortedAgents) - 1
	}
	if sel >= 0 && sel < len(sortedAgents) {
		detail = RenderAgentDetail(sortedAgents[sel], detailW-2, m.theme)
	} else {
		// Show placeholder when no agent selected
		detail = lipgloss.NewStyle().
			Foreground(m.theme.Muted).
			Render("\n  Select an agent from the list to view details")
	}

	// Don't constrain height — let content determine panel size.
	// Height constraint was clipping the detail panel content.
	listPanel := m.theme.PanelStyle.Copy().Width(listW).MaxHeight(height).Render(list)
	detailPanel := m.theme.ActivePanel.Copy().Width(detailW).MaxHeight(height).Render(detail)

	return lipgloss.JoinHorizontal(lipgloss.Top, listPanel, " ", detailPanel)
}

func (m Model) viewChat(width, height int) string {
	filterBar := RenderFilterBar(m.chatFilter, m.theme)
	return lipgloss.JoinVertical(lipgloss.Left, filterBar, m.chatViewport.View())
}

func (m Model) viewHierarchy(width, height int) string {
	return RenderHierarchy(m.hierarchy, m.hierarchyIdx, width, m.theme)
}

func (m Model) viewResources(width, height int) string {
	return RenderResourcePanelExtended(m.resources, m.agents, m.worktrees, width, m.theme)
}

// handleLogKeys handles navigation in the Logs tab.
func (m Model) handleLogKeys(msg tea.KeyMsg) Model {
	switch {
	case key.Matches(msg, m.keys.Up):
		if m.selectedLog > 0 {
			m.selectedLog--
		}
	case key.Matches(msg, m.keys.Down):
		if m.selectedLog < len(m.agents)-1 {
			m.selectedLog++
		}
	case key.Matches(msg, m.keys.Top):
		m.selectedLog = 0
	case key.Matches(msg, m.keys.Bottom):
		if len(m.agents) > 0 {
			m.selectedLog = len(m.agents) - 1
		}
	case key.Matches(msg, m.keys.HalfUp):
		m.selectedLog -= 10
		if m.selectedLog < 0 {
			m.selectedLog = 0
		}
	case key.Matches(msg, m.keys.HalfDown):
		m.selectedLog += 10
		if m.selectedLog >= len(m.agents) {
			m.selectedLog = max(0, len(m.agents)-1)
		}
	}
	return m
}

// handleInternalKeys handles navigation in the Internals tab.
func (m Model) handleInternalKeys(msg tea.KeyMsg) Model {
	// Count agents with quality issues for bounds
	count := 0
	for _, a := range m.agents {
		if a.QualityIssue != "" {
			count++
		}
	}
	if count == 0 {
		count = len(m.agents) // fallback to all agents
	}

	switch {
	case key.Matches(msg, m.keys.Up):
		if m.selectedInternal > 0 {
			m.selectedInternal--
		}
	case key.Matches(msg, m.keys.Down):
		if m.selectedInternal < count-1 {
			m.selectedInternal++
		}
	case key.Matches(msg, m.keys.Top):
		m.selectedInternal = 0
	case key.Matches(msg, m.keys.Bottom):
		m.selectedInternal = max(0, count-1)
	case key.Matches(msg, m.keys.HalfUp):
		m.selectedInternal -= 10
		if m.selectedInternal < 0 {
			m.selectedInternal = 0
		}
	case key.Matches(msg, m.keys.HalfDown):
		m.selectedInternal += 10
		if m.selectedInternal >= count {
			m.selectedInternal = max(0, count-1)
		}
	}
	return m
}

// handleNetworkKeys handles navigation in the Network tab.
func (m Model) handleNetworkKeys(msg tea.KeyMsg) Model {
	entries := BuildNetworkEntries(m.ipcEvents, m.agents)
	count := len(entries)
	if count == 0 {
		return m
	}
	switch {
	case key.Matches(msg, m.keys.Up):
		if m.selectedNet > 0 {
			m.selectedNet--
		}
	case key.Matches(msg, m.keys.Down):
		if m.selectedNet < count-1 {
			m.selectedNet++
		}
	case key.Matches(msg, m.keys.Top):
		m.selectedNet = 0
	case key.Matches(msg, m.keys.Bottom):
		m.selectedNet = max(0, count-1)
	case key.Matches(msg, m.keys.HalfUp):
		m.selectedNet -= 10
		if m.selectedNet < 0 {
			m.selectedNet = 0
		}
	case key.Matches(msg, m.keys.HalfDown):
		m.selectedNet += 10
		if m.selectedNet >= count {
			m.selectedNet = max(0, count-1)
		}
	}
	return m
}

func (m Model) viewLogs(width, height int) string {
	muted := lipgloss.NewStyle().Foreground(m.theme.Muted)

	if len(m.agents) == 0 {
		return muted.Render("  No agent data available")
	}

	// Split panel: log list on left, agent detail on right
	listW := width * 40 / 100
	if listW < 35 {
		listW = 35
	}
	detailW := width - listW - 3

	// Build log entries (all agents, scrollable)
	var listLines []string
	visibleH := height - 3
	if visibleH < 5 {
		visibleH = 5
	}

	// Clamp selection
	sel := m.selectedLog
	if sel >= len(m.agents) {
		sel = len(m.agents) - 1
	}
	if sel < 0 {
		sel = 0
	}

	// Scroll window centered on selection
	startIdx := sel - visibleH/2
	if startIdx < 0 {
		startIdx = 0
	}
	endIdx := startIdx + visibleH
	if endIdx > len(m.agents) {
		endIdx = len(m.agents)
		startIdx = max(0, endIdx-visibleH)
	}

	for i := startIdx; i < endIdx; i++ {
		a := m.agents[i]
		isSelected := i == sel

		// Timestamp
		ts := ""
		if !a.EndTime.IsZero() {
			ts = a.EndTime.Format("15:04:05")
		} else if !a.SpawnTime.IsZero() {
			ts = a.SpawnTime.Format("15:04:05")
		}

		statusIcon := lipgloss.NewStyle().Foreground(m.theme.StatusColor(a.Status)).Render(m.theme.StatusIcon(a.Status))
		name := a.Name
		if name == "" {
			name = a.ID
		}

		nameStyle := lipgloss.NewStyle().Foreground(m.theme.FG)
		if isSelected {
			nameStyle = nameStyle.Bold(true).Foreground(m.theme.Accent)
		}

		prefix := "  "
		if isSelected {
			prefix = "► "
		}

		elapsed := FormatElapsed(a.ElapsedTime())

		line := fmt.Sprintf("%s%s %s %s %s",
			prefix,
			muted.Render(ts),
			statusIcon,
			nameStyle.Render(name),
			muted.Render(elapsed),
		)
		listLines = append(listLines, line)
	}

	// Scroll indicators
	if startIdx > 0 {
		listLines = append([]string{muted.Render(fmt.Sprintf("  ▲ %d more", startIdx))}, listLines...)
	}
	remaining := len(m.agents) - endIdx
	if remaining > 0 {
		listLines = append(listLines, muted.Render(fmt.Sprintf("  ▼ %d more", remaining)))
	}
	listLines = append(listLines, "", muted.Render(fmt.Sprintf("  %d/%d", sel+1, len(m.agents))))

	list := strings.Join(listLines, "\n")

	// Detail view — show full agent output for selected entry
	var detail string
	if sel >= 0 && sel < len(m.agents) {
		a := m.agents[sel]
		detail = RenderAgentDetail(a, detailW-2, m.theme)
	} else {
		detail = muted.Render("\n  Select an entry to view details")
	}

	listPanel := m.theme.PanelStyle.Copy().Width(listW).MaxHeight(height).Render(list)
	detailPanel := m.theme.ActivePanel.Copy().Width(detailW).MaxHeight(height).Render(detail)

	return lipgloss.JoinHorizontal(lipgloss.Top, listPanel, " ", detailPanel)
}

func (m Model) viewHelp(width, height int) string {
	var b strings.Builder
	header := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Accent)
	muted := lipgloss.NewStyle().Foreground(m.theme.Muted)
	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Accent)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.FG)

	b.WriteString(header.Render("  Key Bindings"))
	b.WriteString("\n\n")

	groups := m.keys.FullHelp()
	groupNames := []string{"Global", "Tabs", "Navigation", "Scroll", "Agent Control", "Actions"}

	// Organize into proper table format
	for i, group := range groups {
		if i < len(groupNames) {
			b.WriteString(header.Render("  " + groupNames[i]))
			b.WriteString("\n")
			b.WriteString(muted.Render("  " + strings.Repeat("─", 50)))
			b.WriteString("\n")
		}
		for _, binding := range group {
			h := binding.Help()
			// Left-align key, right-align description with proper spacing
			key := fmt.Sprintf("%-16s", h.Key)
			b.WriteString(fmt.Sprintf("  %s  %s\n",
				keyStyle.Render(key),
				descStyle.Render(h.Desc),
			))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	footer := lipgloss.NewStyle().
		Foreground(m.theme.Accent).
		Bold(true).
		Render("  Press ? to close")
	b.WriteString(footer)

	return b.String()
}
