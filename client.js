import WebSocket from "ws";
import { connect } from "bun";

class TunnelClient {
  constructor(serverUrl = "ws://<server ip>:9090") {
    this.serverUrl = serverUrl;
    this.ws = null;
    this.localPort = null;
    this.serverPort = null;
    this.protocol = "http";
    this.isConnected = false;
  }

  async getConfiguration() {
    const args = process.argv.slice(2);

    let localPort = 3000;
    let serverPort = 5000;
    let protocol = "http";

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === "--local-port" || arg === "-l") {
        localPort = Number.parseInt(args[i + 1]);
        i++;
      } else if (arg === "--server-port" || arg === "-s") {
        serverPort = Number.parseInt(args[i + 1]);
        i++;
      } else if (arg === "--protocol" || arg === "-p") {
        protocol = args[i + 1].toLowerCase();
        i++;
      } else if (arg === "--help" || arg === "-h") {
        this.showHelp();
        process.exit(0);
      } else if (!arg.startsWith("-")) {
        localPort = Number.parseInt(arg);
      }
    }

    if (!["http", "tcp"].includes(protocol)) {
      console.error("❌ Protocol must be 'http' or 'tcp'");
      process.exit(1);
    }

    this.localPort = localPort;
    this.serverPort = serverPort;
    this.protocol = protocol;

    console.log(`🔧 Configuration:`);
    console.log(`   Local port: ${this.localPort}`);
    console.log(`   Server port: ${this.serverPort}`);
    console.log(`   Protocol: ${this.protocol}`);
    console.log(`   Server: ${this.serverUrl}`);
  }

  showHelp() {
    console.log(`
🚀 Revers proxy Bun.js

Usage:
  bun run client [local-port] [options]

Arguments:
  local-port              Local port to proxy (default: 3000)

Options:
  -l, --local-port PORT   Local port to proxy
  -s, --server-port PORT  Server port to use (default: 5000)
  -p, --protocol PROTO    Protocol: http or tcp (default: http)
  -h, --help             Show this help

Examples:
  bun run client                    # Proxy localhost:3000 to server:5000 (http)
  bun run client 8080               # Proxy localhost:8080 to server:5000 (http)
  bun run client -l 3000 -s 8000    # Proxy localhost:3000 to server:8000 (http)
  bun run client -p tcp -l 22       # Proxy localhost:22 to server:5000 (tcp)
  
Server: ws://<server ip>:9090
    `);
  }

  async start() {
    console.log("🚀 Revers proxy Bun.js");
    console.log("=".repeat(50));

    await this.getConfiguration();

    console.log(`\n🔍 Checking local port ${this.localPort}...`);
    if (!(await this.isPortAvailable(this.localPort))) {
      console.error(`❌ No service running on localhost:${this.localPort}`);
      console.log(`💡 Make sure your local service is running first!`);
      process.exit(1);
    }
    console.log(`✅ Local service found on port ${this.localPort}`);

    await this.connectToServer();
  }

  async isPortAvailable(port) {
    try {
      if (this.protocol === "http") {
        const response = await fetch(`http://localhost:${port}`, {
          method: "HEAD",
          signal: AbortSignal.timeout(2000),
        });
        return true;
      } else {
        const socket = await connect({
          hostname: "localhost",
          port: port,
        });
        socket.end();
        return true;
      }
    } catch (error) {
      return false;
    }
  }

  async connectToServer() {
    console.log(`\n🔌 Connecting to tunnel server...`);
    console.log(`   Server: ${this.serverUrl.replace("ws://", "")}`);

    this.ws = new WebSocket(this.serverUrl);

    this.ws.on("open", () => {
      console.log("✅ Connected to tunnel server");
      this.isConnected = true;
      this.register();
    });

    this.ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleServerMessage(message);
      } catch (error) {
        console.error("❌ Error parsing server message:", error);
      }
    });

    this.ws.on("close", () => {
      console.log("\n📱 Disconnected from tunnel server");
      console.log("💡 Trying to reconnect in 5 seconds...");
      setTimeout(() => {
        if (!this.isConnected) {
          this.connectToServer();
        }
      }, 5000);
    });

    this.ws.on("error", (error) => {
      console.error("❌ Connection failed:", error.message);
      console.log("💡 Make sure the tunnel server is running");
    });
  }

  register() {
    const message = {
      type: "register",
      localPort: this.localPort,
      serverPort: this.serverPort,
      protocol: this.protocol,
    };

    this.ws.send(JSON.stringify(message));
  }

  async handleServerMessage(message) {
    switch (message.type) {
      case "registered":
        console.log(`\n🎉 Tunnel established successfully!`);
        console.log("=".repeat(50));
        console.log(`📍 Local:  http://localhost:${message.localPort}`);
        console.log(`🌐 Public: http://<server ip>:${message.serverPort}`);
        console.log(`📡 Protocol: ${message.protocol.toUpperCase()}`);
        console.log("=".repeat(50));
        console.log(`\n✨ Your local service is now publicly accessible!`);
        console.log(
          `🔗 Share this URL: http://<server ip>:${message.serverPort}`
        );
        console.log(`\n📊 Waiting for requests... (Press Ctrl+C to stop)`);
        break;

      case "http_request":
        await this.handleHttpRequest(message);
        break;

      case "tcp_data":
        await this.handleTcpData(message);
        break;

      case "error":
        console.error(`\n❌ Server error: ${message.message}`);
        if (
          message.message.includes("Port") &&
          message.message.includes("in use")
        ) {
          console.log(
            `💡 Try a different server port: bun run client -s ${
              this.serverPort + 1
            }`
          );
        }
        break;

      default:
        console.log(`❓ Unknown message type: ${message.type}`);
    }
  }

  async handleHttpRequest({ requestId, method, url, headers, body }) {
    try {
      console.log(`📨 ${method} ${url}`);

      const requestBody = body ? new Uint8Array(body) : null;

      const response = await fetch(`http://localhost:${this.localPort}${url}`, {
        method,
        headers,
        body: requestBody,
      });

      const responseBody = await response.arrayBuffer();
      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const responseMessage = {
        type: "response",
        requestId,
        status: response.status,
        headers: responseHeaders,
        body: Array.from(new Uint8Array(responseBody)),
      };

      this.ws.send(JSON.stringify(responseMessage));
    } catch (error) {
      console.error(`❌ Error handling HTTP request:`, error);

      const errorMessage = {
        type: "response",
        requestId,
        error: error.message,
      };

      this.ws.send(JSON.stringify(errorMessage));
    }
  }

  async handleTcpData({ requestId, data, socketId }) {
    try {
      console.log(`📨 TCP data from ${socketId} (${data.length} bytes)`);

      const socket = await connect({
        hostname: "localhost",
        port: this.localPort,
      });

      const dataBuffer = new Uint8Array(data);
      socket.write(dataBuffer);

      socket.on("data", (responseData) => {
        const responseMessage = {
          type: "tcp_response",
          requestId,
          data: Array.from(new Uint8Array(responseData)),
          socketId,
        };

        this.ws.send(JSON.stringify(responseMessage));
      });
    } catch (error) {
      console.error(`❌ Error handling TCP data:`, error);
    }
  }
}

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down tunnel client...");
  process.exit(0);
});

const client = new TunnelClient();
client.start().catch(console.error);
