package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

const maxMessageSize = 16 * 1024 * 1024 // 16MB

// IPCMessage represents a message on the IPC bus.
type IPCMessage struct {
	ID            string          `json:"id"`
	Type          string          `json:"type"`
	From          string          `json:"from"`
	To            string          `json:"to,omitempty"`
	Topic         string          `json:"topic,omitempty"`
	CorrelationID string          `json:"correlationId,omitempty"`
	Priority      string          `json:"priority,omitempty"`
	Timestamp     int64           `json:"timestamp"`
	Payload       json.RawMessage `json:"payload,omitempty"`
	Direction     string          `json:"-"` // incoming/outgoing, set locally
}

// TimeFormatted returns the timestamp as a formatted time string.
func (m IPCMessage) TimeFormatted() string {
	t := time.UnixMilli(m.Timestamp)
	return t.Format("15:04:05")
}

// PayloadString returns the payload as a readable string.
func (m IPCMessage) PayloadString() string {
	if m.Payload == nil {
		return ""
	}
	var s string
	if err := json.Unmarshal(m.Payload, &s); err == nil {
		return s
	}
	return string(m.Payload)
}

// TypeColor returns a color hint string for the message type.
func (m IPCMessage) TypeColor() string {
	switch m.Type {
	case "PUBLISH":
		return "#58a6ff" // blue
	case "REQUEST":
		return "#3fb950" // green
	case "RESPONSE":
		return "#79c0ff" // cyan
	case "REGISTER", "UNREGISTER", "HEARTBEAT":
		return "#f85149" // red (control)
	case "DIRECT_SEND":
		return "#d29922" // yellow
	default:
		return "#484f58" // muted
	}
}

// IPCConn manages a connection to the IPC bus.
type IPCConn struct {
	address string
	conn    net.Conn
	mu      sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc

	msgChan chan IPCMessage
	errChan chan error
}

// NewIPCConn creates a new IPC connection manager.
func NewIPCConn(address string) *IPCConn {
	ctx, cancel := context.WithCancel(context.Background())
	return &IPCConn{
		address: address,
		ctx:     ctx,
		cancel:  cancel,
		msgChan: make(chan IPCMessage, 100),
		errChan: make(chan error, 10),
	}
}

// Connect establishes a connection to the Unix domain socket.
func (c *IPCConn) Connect() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	conn, err := net.DialTimeout("unix", c.address, 5*time.Second)
	if err != nil {
		return fmt.Errorf("connect to %s: %w", c.address, err)
	}
	c.conn = conn

	// Send registration message
	reg := map[string]interface{}{
		"id":        "orch-tui-" + fmt.Sprintf("%d", time.Now().UnixMilli()),
		"type":      "REGISTER",
		"from":      "orch-tui",
		"timestamp": time.Now().UnixMilli(),
		"payload": map[string]interface{}{
			"agentId":      "orch-tui",
			"role":         "monitor",
			"capabilities": []string{"monitor"},
		},
	}
	if err := c.writeMessage(reg); err != nil {
		conn.Close()
		c.conn = nil
		return fmt.Errorf("send registration: %w", err)
	}

	// Subscribe to all topics
	sub := map[string]interface{}{
		"id":        fmt.Sprintf("sub-%d", time.Now().UnixMilli()),
		"type":      "SUBSCRIBE",
		"from":      "orch-tui",
		"topic":     "*",
		"timestamp": time.Now().UnixMilli(),
		"payload":   nil,
	}
	if err := c.writeMessage(sub); err != nil {
		conn.Close()
		c.conn = nil
		return fmt.Errorf("send subscription: %w", err)
	}

	go c.readLoop()
	return nil
}

func (c *IPCConn) readLoop() {
	defer func() {
		c.mu.Lock()
		if c.conn != nil {
			c.conn.Close()
		}
		c.mu.Unlock()
	}()

	for {
		select {
		case <-c.ctx.Done():
			return
		default:
		}

		msg, err := c.readMessage()
		if err != nil {
			if c.ctx.Err() != nil {
				return
			}
			select {
			case c.errChan <- err:
			default:
			}
			return
		}

		select {
		case c.msgChan <- msg:
		default:
			// Drop message if channel is full
		}
	}
}

func (c *IPCConn) readMessage() (IPCMessage, error) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()

	if conn == nil {
		return IPCMessage{}, fmt.Errorf("not connected")
	}

	// Read 4-byte length prefix
	lenBuf := make([]byte, 4)
	if _, err := io.ReadFull(conn, lenBuf); err != nil {
		return IPCMessage{}, fmt.Errorf("read length: %w", err)
	}

	msgLen := binary.BigEndian.Uint32(lenBuf)
	if msgLen > maxMessageSize {
		return IPCMessage{}, fmt.Errorf("message too large: %d bytes", msgLen)
	}

	// Read JSON payload
	payload := make([]byte, msgLen)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return IPCMessage{}, fmt.Errorf("read payload: %w", err)
	}

	var msg IPCMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		return IPCMessage{}, fmt.Errorf("parse message: %w", err)
	}

	msg.Direction = "incoming"
	return msg, nil
}

func (c *IPCConn) writeMessage(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}

	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()

	if conn == nil {
		return fmt.Errorf("not connected")
	}

	lenBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(lenBuf, uint32(len(data)))

	if _, err := conn.Write(lenBuf); err != nil {
		return err
	}
	if _, err := conn.Write(data); err != nil {
		return err
	}
	return nil
}

// SendControl sends a control command to an agent via the bus.
func (c *IPCConn) SendControl(command, agentID string) error {
	msg := map[string]interface{}{
		"id":        fmt.Sprintf("ctrl-%d", time.Now().UnixMilli()),
		"type":      "DIRECT_SEND",
		"from":      "orch-tui",
		"to":        agentID,
		"timestamp": time.Now().UnixMilli(),
		"payload": map[string]interface{}{
			"command": command,
		},
	}
	return c.writeMessage(msg)
}

// SendBusCommand sends a structured command to the message bus.
func (c *IPCConn) SendBusCommand(command string, payload map[string]interface{}) error {
	msg := map[string]interface{}{
		"id":        fmt.Sprintf("cmd-%d", time.Now().UnixMilli()),
		"type":      "DIRECT_SEND",
		"from":      "orch-tui",
		"to":        "message-bus",
		"timestamp": time.Now().UnixMilli(),
		"payload": map[string]interface{}{
			"command": command,
		},
	}
	// Merge payload fields
	for k, v := range payload {
		msg["payload"].(map[string]interface{})[k] = v
	}
	return c.writeMessage(msg)
}

// PauseAgent sends a pause command for the specified agent.
func (c *IPCConn) PauseAgent(agentID string) error {
	return c.SendBusCommand("pause_agent", map[string]interface{}{
		"agentId": agentID,
	})
}

// ResumeAgent sends a resume command for the specified agent.
func (c *IPCConn) ResumeAgent(agentID string) error {
	return c.SendBusCommand("resume_agent", map[string]interface{}{
		"agentId": agentID,
	})
}

// DisconnectAgent sends a disconnect command for the specified agent.
func (c *IPCConn) DisconnectAgent(agentID string) error {
	return c.SendBusCommand("disconnect_agent", map[string]interface{}{
		"agentId": agentID,
	})
}

// QueryState sends a query_state command to the bus.
func (c *IPCConn) QueryState() error {
	return c.SendBusCommand("query_state", nil)
}

// GetBusStats sends a get_bus_stats command to the bus.
func (c *IPCConn) GetBusStats() error {
	return c.SendBusCommand("get_bus_stats", nil)
}

// Close shuts down the IPC connection.
func (c *IPCConn) Close() {
	c.cancel()
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.mu.Unlock()
}

// IsConnected returns whether the IPC bus is connected.
func (c *IPCConn) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn != nil
}

// Bubble Tea message types for IPC integration

type ipcMsg struct {
	msg IPCMessage
}

type ipcErrMsg struct {
	err error
}

type ipcConnectedMsg struct{}
type ipcDisconnectedMsg struct{}

// listenForIPCMessages returns a Bubble Tea command that reads messages from the IPC bus.
func listenForIPCMessages(conn *IPCConn) tea.Cmd {
	return func() tea.Msg {
		select {
		case msg := <-conn.msgChan:
			return ipcMsg{msg: msg}
		case err := <-conn.errChan:
			return ipcErrMsg{err: err}
		case <-conn.ctx.Done():
			return ipcDisconnectedMsg{}
		}
	}
}

// connectToIPC attempts to connect to the IPC bus and returns appropriate messages.
func connectToIPC(address string) tea.Cmd {
	return func() tea.Msg {
		conn := NewIPCConn(address)
		if err := conn.Connect(); err != nil {
			return ipcErrMsg{err: err}
		}
		return ipcConnectedMsg{}
	}
}
