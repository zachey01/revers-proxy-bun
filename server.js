import { serve } from "bun";
import { WebSocketServer } from "ws";
import Bun from "bun"; 

class TunnelServer {
  constructor() {
    this.clients = new Map(); // clientId -> { ws, localPort, serverPort, proxyServer }
    this.portMappings = new Map(); // serverPort -> clientId
    this.proxyServers = new Map(); // serverPort -> server instance
  }

  async start() {
    console.log("🚀 Tunnel Server starting on port 9090...");

    const wss = new WebSocketServer({ port: 9090 });

    wss.on("connection", (ws) => {
      const clientId = this.generateClientId();
      console.log(`📱 Client ${clientId} connected`);

      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());
          await this.handleClientMessage(clientId, ws, message);
        } catch (error) {
          console.error(`❌ Error handling message from ${clientId}:`, error);
          ws.send(JSON.stringify({ type: "error", message: error.message }));
        }
      });

      ws.on("close", () => {
        console.log(`📱 Client ${clientId} disconnected`);
        this.cleanupClient(clientId);
      });

      ws.on("error", (error) => {
        console.error(`❌ WebSocket error for ${clientId}:`, error);
        this.cleanupClient(clientId);
      });
    });

    console.log("✅ Tunnel Server is running on ws://localhost:9090");
  }

  async handleClientMessage(clientId, ws, message) {
    switch (message.type) {
      case "register":
        await this.registerClient(clientId, ws, message);
        break;
      case "response":
        await this.forwardResponse(clientId, message);
        break;
      default:
        console.log(`❓ Unknown message type: ${message.type}`);
    }
  }

  async registerClient(
    clientId,
    ws,
    { localPort, serverPort, protocol = "http" }
  ) {
    if (this.portMappings.has(serverPort)) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Port ${serverPort} is already in use`,
        })
      );
      return;
    }

    try {
      // Create proxy server on the specified port
      const proxyServer = await this.createProxyServer(
        serverPort,
        clientId,
        protocol
      );

      // Store client info
      this.clients.set(clientId, {
        ws,
        localPort,
        serverPort,
        protocol,
        proxyServer,
        pendingRequests: new Map(),
      });

      this.portMappings.set(serverPort, clientId);
      this.proxyServers.set(serverPort, proxyServer);

      ws.send(
        JSON.stringify({
          type: "registered",
          clientId,
          localPort,
          serverPort,
          protocol,
          publicUrl: `http://localhost:${serverPort}`,
        })
      );

      console.log(
        `✅ Client ${clientId} registered: localhost:${localPort} -> localhost:${serverPort} (${protocol})`
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Failed to create proxy server: ${error.message}`,
        })
      );
    }
  }

  async createProxyServer(port, clientId, protocol) {
    if (protocol === "http") {
      return serve({
        port,
        fetch: async (req) => {
          return this.handleHttpRequest(clientId, req);
        },
      });
    } else if (protocol === "tcp") {
      // For TCP, we'll use Bun's TCP server
      const server = Bun.listen({
        hostname: "localhost",
        port,
        socket: {
          data: (socket, data) => {
            this.handleTcpData(clientId, socket, data);
          },
          open: (socket) => {
            console.log(`🔌 TCP connection opened for client ${clientId}`);
          },
          close: (socket) => {
            console.log(`🔌 TCP connection closed for client ${clientId}`);
          },
          error: (socket, error) => {
            console.error(`❌ TCP socket error for client ${clientId}:`, error);
          },
        },
      });
      return server;
    }
  }

  async handleHttpRequest(clientId, req) {
    const client = this.clients.get(clientId);
    if (!client) {
      return new Response("Client not found", { status: 502 });
    }

    const requestId = this.generateRequestId();
    const url = new URL(req.url);

    const headers = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const body = req.body ? await req.arrayBuffer() : null;

    const requestData = {
      type: "http_request",
      requestId,
      method: req.method,
      url: url.pathname + url.search,
      headers,
      body: body ? Array.from(new Uint8Array(body)) : null,
    };

    client.ws.send(JSON.stringify(requestData));

    return new Promise((resolve) => {
      client.pendingRequests.set(requestId, resolve);

      setTimeout(() => {
        if (client.pendingRequests.has(requestId)) {
          client.pendingRequests.delete(requestId);
          resolve(new Response("Gateway Timeout", { status: 504 }));
        }
      }, 30000);
    });
  }

  handleTcpData(clientId, socket, data) {
    const client = this.clients.get(clientId);
    if (!client) {
      socket.end();
      return;
    }

    const requestId = this.generateRequestId();

    const requestData = {
      type: "tcp_data",
      requestId,
      data: Array.from(new Uint8Array(data)),
      socketId: socket.remoteAddress + ":" + socket.remotePort,
    };

    client.ws.send(JSON.stringify(requestData));
  }

  async forwardResponse(clientId, { requestId, status, headers, body, error }) {
    const client = this.clients.get(clientId);
    if (!client || !client.pendingRequests.has(requestId)) {
      return;
    }

    const resolve = client.pendingRequests.get(requestId);
    client.pendingRequests.delete(requestId);

    if (error) {
      resolve(new Response(error, { status: 502 }));
      return;
    }

    const responseBody = body ? new Uint8Array(body) : null;
    resolve(new Response(responseBody, { status, headers }));
  }

  cleanupClient(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      if (client.proxyServer) {
        client.proxyServer.stop?.();
      }

      this.portMappings.delete(client.serverPort);
      this.proxyServers.delete(client.serverPort);
      this.clients.delete(clientId);

      console.log(`🧹 Cleaned up client ${clientId}`);
    }
  }

  generateClientId() {
    return Math.random().toString(36).substring(2, 15);
  }

  generateRequestId() {
    return Math.random().toString(36).substring(2, 15);
  }
}

const server = new TunnelServer();
server.start().catch(console.error);
