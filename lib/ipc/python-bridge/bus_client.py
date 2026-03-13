#!/usr/bin/env python3
"""
IPC Bus Client for Python

Complete Python 3 stdlib-only client for connecting to the IPC message bus.
Uses 4-byte big-endian length-prefixed JSON protocol matching protocol.mjs.

Features:
- Connect to Unix domain socket bus
- Send direct messages to agents
- Publish to topics
- Subscribe to topics with background thread
- Request-response pattern with timeout
- CLI mode for shell scripts and hooks
- Zero external dependencies (stdlib only)

Usage as library:
    from bus_client import BusClient

    client = BusClient("my-agent", socket_path="/tmp/claude-ipc-bus.sock")
    client.connect()

    # Send direct message
    client.send("agent-01", {"type": "task", "data": {...}})

    # Publish to topic
    client.publish("progress", {"agent_id": "my-agent", "progress": 0.5})

    # Subscribe to topic
    def on_task(msg):
        print("Received task:", msg)

    client.subscribe("tasks", on_task)

    # Request-response
    response = client.request("orchestrator", {"type": "get_config"}, timeout=5.0)

    client.close()

Usage from CLI:
    # Send message
    python3 bus_client.py send agent-01 '{"type": "task"}'

    # Publish to topic
    python3 bus_client.py publish progress '{"progress": 0.5}'

    # Request-response
    python3 bus_client.py request orchestrator '{"type": "status"}' 5.0

    # Subscribe and listen (blocks until Ctrl+C)
    python3 bus_client.py subscribe tasks
"""

import json
import os
import socket
import struct
import sys
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional


class BusClient:
    """
    IPC bus client for Python hooks and scripts.

    Protocol: 4-byte big-endian length prefix + UTF-8 JSON message body.
    """

    def __init__(
        self,
        agent_id: str,
        socket_path: Optional[str] = None,
        auto_reconnect: bool = False
    ):
        """
        Initialize bus client.

        Args:
            agent_id: Unique identifier for this client
            socket_path: Unix socket path (default: from env or /tmp/claude-ipc-bus.sock)
            auto_reconnect: Enable auto-reconnect on connection loss
        """
        self.agent_id = agent_id
        self.socket_path = socket_path or os.environ.get(
            "ARBOR_IPC_SOCKET",
            os.environ.get("CLAUDE_IPC_SOCKET", "/tmp/claude-ipc-bus.sock")
        )
        self.auto_reconnect = auto_reconnect

        self.sock: Optional[socket.socket] = None
        self.connected = False

        # Receive buffer for frame parsing
        self.recv_buffer = b""

        # Pending requests (for request-response pattern)
        self.pending_requests: Dict[str, Dict[str, Any]] = {}
        self.next_request_id = 1

        # Subscriptions
        self.topic_handlers: Dict[str, list] = {}
        self.message_handler: Optional[Callable] = None

        # Background receiver thread
        self.receiver_thread: Optional[threading.Thread] = None
        self.receiver_running = False
        self.receiver_lock = threading.Lock()

    def connect(self) -> None:
        """
        Connect to the IPC bus.

        Raises:
            ConnectionError: If connection fails
        """
        if self.connected:
            return

        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect(self.socket_path)
            self.connected = True

            # Send registration message
            self._send_frame(self._create_message(
                type="REGISTER",
                from_=self.agent_id,
                payload={
                    "agentId": self.agent_id,
                    "pid": os.getpid(),
                },
                timestamp=int(time.time() * 1000)
            ))

            # Start receiver thread
            self._start_receiver()

        except Exception as e:
            raise ConnectionError(f"Failed to connect to {self.socket_path}: {e}")

    def close(self) -> None:
        """
        Close the connection gracefully.
        """
        if not self.connected:
            return

        # Stop receiver thread
        self._stop_receiver()

        # Send unregister message
        if self.sock:
            try:
                self._send_frame(self._create_message(
                    type="UNREGISTER",
                    from_=self.agent_id,
                    payload={
                        "agentId": self.agent_id,
                    },
                    timestamp=int(time.time() * 1000)
                ))
            except:
                pass

            try:
                self.sock.close()
            except:
                pass

        self.sock = None
        self.connected = False

    def send(self, target_agent_id: str, message: Dict[str, Any]) -> None:
        """
        Send a message to a specific agent.

        Args:
            target_agent_id: Recipient agent ID
            message: Message payload (must be JSON-serializable)

        Raises:
            RuntimeError: If not connected
        """
        if not self.connected:
            raise RuntimeError("Not connected to IPC bus")

        self._send_frame(self._create_message(
            type="DIRECT_SEND",
            from_=self.agent_id,
            to=target_agent_id,
            payload=message,
            timestamp=int(time.time() * 1000)
        ))

    def publish(self, topic: str, message: Dict[str, Any]) -> None:
        """
        Publish a message to a topic.

        Args:
            topic: Topic name
            message: Message payload (must be JSON-serializable)

        Raises:
            RuntimeError: If not connected
        """
        if not self.connected:
            raise RuntimeError("Not connected to IPC bus")

        self._send_frame(self._create_message(
            type="PUBLISH",
            from_=self.agent_id,
            topic=topic,
            payload=message,
            timestamp=int(time.time() * 1000)
        ))

    def subscribe(self, topic: str, handler: Callable[[Dict[str, Any]], None]) -> None:
        """
        Subscribe to a topic.

        Args:
            topic: Topic name
            handler: Callback function that receives message payloads
        """
        if topic not in self.topic_handlers:
            self.topic_handlers[topic] = []

            # Send subscription message to bus
            if self.connected:
                self._send_frame(self._create_message(
                    type="SUBSCRIBE",
                    from_=self.agent_id,
                    topic=topic,
                    timestamp=int(time.time() * 1000)
                ))

        self.topic_handlers[topic].append(handler)

    def unsubscribe(self, topic: str, handler: Optional[Callable] = None) -> None:
        """
        Unsubscribe from a topic.

        Args:
            topic: Topic name
            handler: Specific handler to remove (or all if None)
        """
        if topic not in self.topic_handlers:
            return

        if handler:
            try:
                self.topic_handlers[topic].remove(handler)
            except ValueError:
                pass

            if not self.topic_handlers[topic]:
                del self.topic_handlers[topic]
                self._send_unsubscribe(topic)
        else:
            del self.topic_handlers[topic]
            self._send_unsubscribe(topic)

    def request(
        self,
        target_agent_id: str,
        message: Dict[str, Any],
        timeout: float = 5.0
    ) -> Dict[str, Any]:
        """
        Send a request and wait for response.

        Args:
            target_agent_id: Recipient agent ID
            message: Request message
            timeout: Timeout in seconds

        Returns:
            Response payload

        Raises:
            RuntimeError: If not connected
            TimeoutError: If request times out
        """
        if not self.connected:
            raise RuntimeError("Not connected to IPC bus")

        # Create request message (id will be auto-generated by _create_message)
        req_msg = self._create_message(
            type="REQUEST",
            from_=self.agent_id,
            to=target_agent_id,
            payload=message,
            timestamp=int(time.time() * 1000)
        )

        # Use the message id as the key for tracking the pending request
        request_id = req_msg["id"]

        # Create event for response notification
        event = threading.Event()
        response_data = {"response": None, "error": None}

        self.pending_requests[request_id] = {
            "event": event,
            "response_data": response_data
        }

        try:
            self._send_frame(req_msg)

            # Wait for response
            if not event.wait(timeout):
                raise TimeoutError(f"Request timeout after {timeout}s")

            if response_data["error"]:
                raise RuntimeError(response_data["error"])

            return response_data["response"]

        finally:
            self.pending_requests.pop(request_id, None)

    def on_message(self, handler: Callable[[Dict[str, Any]], None]) -> None:
        """
        Register a global message handler.

        Args:
            handler: Callback that receives all messages
        """
        self.message_handler = handler

    def _create_message(self, **kwargs) -> Dict[str, Any]:
        """
        Create a message dict with default fields.

        Default fields: id, to, topic, correlationId, priority (all None except id).
        Kwargs override defaults. Use from_ parameter for the 'from' field.

        Returns:
            Message dict ready for _send_frame()
        """
        message = {
            "id": str(uuid.uuid4()),
            "to": None,
            "topic": None,
            "correlationId": None,
            "priority": None,
        }
        # Handle 'from_' -> 'from' renaming (from is a Python keyword)
        if "from_" in kwargs:
            kwargs["from"] = kwargs.pop("from_")
        message.update(kwargs)
        # Remove None values to keep messages clean
        return {k: v for k, v in message.items() if v is not None}

    def _send_frame(self, message: Dict[str, Any]) -> None:
        """
        Send a frame over the socket (internal).

        Protocol: 4-byte big-endian length + UTF-8 JSON
        """
        if not self.sock:
            return

        try:
            json_str = json.dumps(message)
            json_bytes = json_str.encode("utf-8")
            length = len(json_bytes)

            # Pack length as big-endian uint32
            header = struct.pack(">I", length)

            # Send frame
            self.sock.sendall(header + json_bytes)

        except Exception as e:
            print(f"[BusClient] Send error: {e}", file=sys.stderr)
            self._handle_disconnect()

    def _start_receiver(self) -> None:
        """
        Start background receiver thread (internal).
        """
        if self.receiver_thread and self.receiver_running:
            return

        self.receiver_running = True
        self.receiver_thread = threading.Thread(
            target=self._receiver_loop,
            daemon=True
        )
        self.receiver_thread.start()

    def _stop_receiver(self) -> None:
        """
        Stop background receiver thread (internal).
        """
        self.receiver_running = False

        if self.receiver_thread:
            # Give thread 1s to exit gracefully
            self.receiver_thread.join(timeout=1.0)
            self.receiver_thread = None

    def _receiver_loop(self) -> None:
        """
        Background receiver thread loop (internal).
        """
        while self.receiver_running and self.connected:
            try:
                # Receive data with timeout to allow checking receiver_running
                self.sock.settimeout(0.5)
                chunk = self.sock.recv(4096)

                if not chunk:
                    # Connection closed
                    self._handle_disconnect()
                    break

                self._handle_incoming_data(chunk)

            except socket.timeout:
                continue
            except Exception as e:
                if self.receiver_running:
                    print(f"[BusClient] Receiver error: {e}", file=sys.stderr)
                    self._handle_disconnect()
                break

    def _handle_incoming_data(self, chunk: bytes) -> None:
        """
        Handle incoming data and parse frames (internal).
        """
        with self.receiver_lock:
            self.recv_buffer += chunk

            # Parse all complete frames
            while len(self.recv_buffer) >= 4:
                length = struct.unpack(">I", self.recv_buffer[:4])[0]

                if len(self.recv_buffer) < 4 + length:
                    break  # Incomplete frame

                json_bytes = self.recv_buffer[4:4 + length]
                self.recv_buffer = self.recv_buffer[4 + length:]

                try:
                    message = json.loads(json_bytes.decode("utf-8"))
                    self._handle_message(message)
                except Exception as e:
                    print(f"[BusClient] Parse error: {e}", file=sys.stderr)

    def _handle_message(self, message: Dict[str, Any]) -> None:
        """
        Handle parsed message (internal).
        """
        msg_type = message.get("type")

        # Handle responses to pending requests
        if msg_type == "RESPONSE":
            correlation_id = message.get("correlationId")
            if correlation_id and correlation_id in self.pending_requests:
                pending = self.pending_requests[correlation_id]
                payload = message.get("payload", {})

                if message.get("error"):
                    pending["response_data"]["error"] = message["error"]
                else:
                    pending["response_data"]["response"] = payload

                pending["event"].set()
                return

        # Handle topic messages
        if msg_type == "PUBLISH":
            topic = message.get("topic")
            if topic and topic in self.topic_handlers:
                payload = message.get("payload", {})
                for handler in self.topic_handlers[topic]:
                    try:
                        handler(payload)
                    except Exception as e:
                        print(f"[BusClient] Topic handler error: {e}", file=sys.stderr)

        # Call global message handler
        if self.message_handler:
            try:
                self.message_handler(message)
            except Exception as e:
                print(f"[BusClient] Message handler error: {e}", file=sys.stderr)

    def _handle_disconnect(self) -> None:
        """
        Handle connection loss (internal).
        """
        if not self.connected:
            return

        self.connected = False
        self.receiver_running = False

        if self.sock:
            try:
                self.sock.close()
            except:
                pass

        print(f"[BusClient] Disconnected from {self.socket_path}", file=sys.stderr)

    def _send_unsubscribe(self, topic: str) -> None:
        """
        Send unsubscribe message (internal).
        """
        if self.connected:
            self._send_frame(self._create_message(
                type="UNSUBSCRIBE",
                from_=self.agent_id,
                topic=topic,
                timestamp=int(time.time() * 1000)
            ))


def cli_main():
    """
    CLI mode for shell scripts and hooks.
    """
    # Handle optional --async flag (for compatibility, doesn't change behavior)
    args = sys.argv[1:]
    if args and args[0] == "--async":
        args = args[1:]

    if len(args) < 2:
        print(f"""Usage:
  {sys.argv[0]} [--async] send <target> '<json>'
  {sys.argv[0]} [--async] publish <topic> '<json>'
  {sys.argv[0]} [--async] request <target> '<json>' [timeout]
  {sys.argv[0]} [--async] subscribe <topic>""", file=sys.stderr)
        sys.exit(1)

    command = args[0]
    target_or_topic = args[1]

    # Create client
    client_id = f"cli-{os.getpid()}"
    client = BusClient(client_id)

    try:
        client.connect()
    except Exception as e:
        print(f"Failed to connect: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        if command == "send":
            if len(args) < 3:
                print("Missing JSON payload", file=sys.stderr)
                sys.exit(1)

            payload = json.loads(args[2])
            client.send(target_or_topic, payload)
            print(f"Sent message to {target_or_topic}")

        elif command == "publish":
            if len(args) < 3:
                print("Missing JSON payload", file=sys.stderr)
                sys.exit(1)

            payload = json.loads(args[2])
            client.publish(target_or_topic, payload)
            print(f"Published to topic {target_or_topic}")

        elif command == "request":
            if len(args) < 3:
                print("Missing JSON payload", file=sys.stderr)
                sys.exit(1)

            payload = json.loads(args[2])
            timeout = float(args[3]) if len(args) > 3 else 5.0

            response = client.request(target_or_topic, payload, timeout)
            print(json.dumps(response, indent=2))

        elif command == "subscribe":
            topic = target_or_topic

            def on_message(msg):
                print(json.dumps(msg, indent=2))
                sys.stdout.flush()

            client.subscribe(topic, on_message)
            print(f"Subscribed to {topic}, listening... (Ctrl+C to exit)", file=sys.stderr)

            # Block forever
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                print("\nExiting", file=sys.stderr)

        else:
            print(f"Unknown command: {command}", file=sys.stderr)
            sys.exit(1)

        client.close()

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        client.close()
        sys.exit(1)


if __name__ == "__main__":
    cli_main()
