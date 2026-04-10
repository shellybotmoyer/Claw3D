"use strict";

/**
 * Direct Hermes WebSocket Gateway for Claw3D
 * 
 * This gateway speaks the Claw3D gateway protocol directly,
 * eliminating the need for the HTTP adapter translation layer.
 * 
 * It connects to the Hermes HTTP API and translates WebSocket
 * messages from Claw3D Studio into Hermes API calls.
 */

const { Buffer } = require("node:buffer");
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");

function loadDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadRuntimeEnv() {
  const cwd = process.cwd();
  loadDotenvFile(path.join(cwd, ".env.local"));
  loadDotenvFile(path.join(cwd, ".env"));
}

loadRuntimeEnv();

// Configuration from environment
const HERMES_API_URL = (process.env.HERMES_API_URL || "http://localhost:8644").replace(/\/$/, "");
const HERMES_API_KEY = process.env.HERMES_API_KEY || "";
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "18789", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Hermes agent identity
const AGENT_ID = "hermes";
const AGENT_NAME = process.env.HERMES_AGENT_NAME || "Hermes";
const MODEL = process.env.HERMES_MODEL || "hermes";

console.log(`[hermes-direct-gateway] Starting Hermes WebSocket Gateway`);
console.log(`[hermes-direct-gateway] Hermes API: ${HERMES_API_URL}`);
console.log(`[hermes-direct-gateway] Gateway Port: ${GATEWAY_PORT}`);
console.log(`[hermes-direct-gateway] Host: ${HOST}`);

// In-memory state for Hermes agent
const conversationHistory = new Map(); // sessionKey -> messages
const agentRegistry = new Map(); // agentId -> agentInfo
const activeSendEventFns = new Set(); // WebSocket broadcast functions

// Initialize with the main Hermes agent
const mainAgentInfo = {
  id: AGENT_ID,
  name: AGENT_NAME,
  model: MODEL,
  role: "Orchestrator",
  systemPrompt: `You are ${AGENT_NAME}, an AI agent in the Claw3D 3D office. You can help with various tasks and converse with users.`,
  sessionKey: `agent:${AGENT_ID}:main`
};

// Add main agent to registry
agentRegistry.set(AGENT_ID, mainAgentInfo);
conversationHistory.set(mainAgentInfo.sessionKey, []);

// Hermes HTTP API helpers
function hermesPost(path, body) {
  return new Promise((resolve, reject) => {
    const urlStr = HERMES_API_URL + path;
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const transport = url.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) };
    if (HERMES_API_KEY) headers["Authorization"] = `Bearer ${HERMES_API_KEY}`;
    const req = transport.request(
      { hostname: url.hostname, port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""), method: "POST", headers },
      resolve
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function hermesGet(path) {
  return new Promise((resolve, reject) => {
    const urlStr = HERMES_API_URL + path;
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const transport = url.protocol === "https:" ? https : http;
    const headers = {};
    if (HERMES_API_KEY) headers["Authorization"] = `Bearer ${HERMES_API_KEY}`;
    const req = transport.request(
      { hostname: url.hostname, port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""), method: "GET", headers },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

async function readJsonBody(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// WebSocket message handler for Claw3D gateway protocol
async function handleClaw3DMessage(ws, message) {
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch (err) {
    ws.send(JSON.stringify({
      type: "res",
      id: msgId || "unknown",
      ok: false,
      error: { code: "invalid_json", message: "Invalid JSON format" }
    }));
    return;
  }

  const { type, id, method, params } = parsed;
  const msgId = id || null;

  // Handle different message types
  if (type === "req") {
    await handleRequest(ws, msgId, method, params);
  } else if (type === "res") {
    // Response messages are handled by the caller
  } else {
    ws.send(JSON.stringify({
      type: "res",
      id: msgId,
      ok: false,
      error: { code: "unknown_message_type", message: `Unknown message type: ${type}` }
    }));
  }
}

async function handleRequest(ws, msgId, method, params) {
  try {
    let result;
    
    switch (method) {
      case "hello":
        result = await handleHello(params);
        break;
      case "agent.list":
        result = await handleAgentList(params);
        break;
      case "agent.create":
        result = await handleAgentCreate(params);
        break;
      case "agent.get":
        result = await handleAgentGet(params);
        break;
      case "agent.update":
        result = await handleAgentUpdate(params);
        break;
      case "agent.delete":
        result = await handleAgentDelete(params);
        break;
      case "session.list":
        result = await handleSessionList(params);
        break;
      case "session.create":
        result = await handleSessionCreate(params);
        break;
      case "session.get":
        result = await handleSessionGet(params);
        break;
      case "session.update":
        result = await handleSessionUpdate(params);
        break;
      case "session.delete":
        result = await handleSessionDelete(params);
        break;
      case "chat.send":
        result = await handleChatSend(params);
        break;
      case "chat.abort":
        result = await handleChatAbort(params);
        break;
      case "config.get":
        result = await handleConfigGet(params);
        break;
      case "config.set":
        result = await handleConfigSet(params);
        break;
      case "config.patch":
        result = await handleConfigPatch(params);
        break;
      default:
        throw new Error(`Unknown method: ${method}`);
    }
    
    ws.send(JSON.stringify({
      type: "res",
      id: msgId,
      ok: true,
      result: result
    }));
    
  } catch (error) {
    console.error(`[hermes-direct-gateway] Error handling ${method}:`, error);
    ws.send(JSON.stringify({
      type: "res",
      id: msgId,
      ok: false,
      error: { 
        code: "internal_error", 
        message: error.message || "Unknown error" 
      }
    }));
  }
}

// Method handlers
async function handleHello(params) {
  return {
    agentId: AGENT_ID,
    agentName: AGENT_NAME,
    version: "0.1.0",
    capabilities: [
      "agent.list", "agent.create", "agent.get", "agent.update", "agent.delete",
      "session.list", "session.create", "session.get", "session.update", "session.delete",
      "chat.send", "chat.abort",
      "config.get", "config.set", "config.patch"
    ]
  };
}

async function handleAgentList(params) {
  const agents = [];
  for (const [id, info] of agentRegistry.entries()) {
    agents.push({
      id: info.id,
      name: info.name,
      model: info.model,
      role: info.role || "",
      activeSessionCount: 1 // Simplified
    });
  }
  return { agents };
}

async function handleAgentCreate(params) {
  const { name, role, model, instructions } = params || {};
  const agentId = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const agentInfo = {
    id: agentId,
    name: name || `Agent ${agentId}`,
    model: model || MODEL,
    role: role || "Specialist",
    systemPrompt: instructions || `You are a helpful AI agent.`,
    sessionKey: `agent:${agentId}:main`
  };
  
  agentRegistry.set(agentId, agentInfo);
  conversationHistory.set(agentInfo.sessionKey, []);
  
  // Broadcast agent creation
  broadcastEvent({
    type: "event",
    event: "agent.created",
    agent: {
      id: agentInfo.id,
      name: agentInfo.name,
      model: agentInfo.model,
      role: agentInfo.role
    }
  });
  
  return { agentId: agentInfo.id };
}

async function handleAgentGet(params) {
  const { agentId } = params || {};
  const agentInfo = agentRegistry.get(agentId);
  if (!agentInfo) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return {
    id: agentInfo.id,
    name: agentInfo.name,
    model: agentInfo.model,
    role: agentInfo.role || "",
    systemPrompt: agentInfo.systemPrompt || ""
  };
}

async function handleAgentUpdate(params) {
  const { agentId, name, role, model, instructions } = params || {};
  const agentInfo = agentRegistry.get(agentId);
  if (!agentInfo) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  
  if (name !== undefined) agentInfo.name = name;
  if (role !== undefined) agentInfo.role = role;
  if (model !== undefined) agentInfo.model = model;
  if (instructions !== undefined) agentInfo.systemPrompt = instructions;
  
  return { success: true };
}

async function handleAgentDelete(params) {
  const { agentId } = params || {};
  if (!agentRegistry.has(agentId)) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  
  // Don't allow deleting the main Hermes agent
  if (agentId === AGENT_ID) {
    throw new Error(`Cannot delete the main Hermes agent`);
  }
  
  agentRegistry.delete(agentId);
  conversationHistory.delete(`agent:${agentId}:main`);
  
  // Broadcast agent deletion
  broadcastEvent({
    type: "event",
    event: "agent.deleted",
    agentId
  });
  
  return { success: true };
}

async function handleSessionList(params) {
  const sessions = [];
  for (const [sessionKey, messages] of conversationHistory.entries()) {
    // Extract agentId from sessionKey: agent:{agentId}:{sessionKey}
    const match = sessionKey.match(/^agent:(.+):.+$/);
    if (match) {
      const agentId = match[1];
      const agentInfo = agentRegistry.get(agentId);
      sessions.push({
        id: sessionKey,
        agentId: agentId,
        agentName: agentInfo ? agentInfo.name : "Unknown",
        messageCount: messages.length,
        updatedAt: new Date().toISOString() // Simplified
      });
    }
  }
  return { sessions };
}

async function handleSessionCreate(params) {
  const { agentId, sessionKey } = params || {};
  const targetSessionKey = sessionKey || `agent:${agentId || AGENT_ID}:main`;
  
  if (!conversationHistory.has(targetSessionKey)) {
    conversationHistory.set(targetSessionKey, []);
    
    // If this is a new agent, make sure it's registered
    if (agentId && !agentRegistry.has(agentId)) {
      await handleAgentCreate({ 
        name: agentId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        role: "Specialist"
      });
    }
  }
  
  return { sessionKey: targetSessionKey };
}

async function handleSessionGet(params) {
  const { sessionKey } = params || {};
  const messages = conversationHistory.get(sessionKey) || [];
  return {
    sessionKey: sessionKey || "",
    messages: messages.map(msg => ({
      id: msg.id || `${Date.now()}_${Math.random()}`,
      role: msg.role || "user",
      content: msg.content || "",
      createdAt: msg.createdAt || new Date().toISOString()
    }))
  };
}

async function handleSessionUpdate(params) {
  // For now, session updates are not implemented
  return { success: true };
}

async function handleSessionDelete(params) {
  const { sessionKey } = params || {};
  if (conversationHistory.has(sessionKey)) {
    conversationHistory.delete(sessionKey);
    
    // Broadcast session deletion
    broadcastEvent({
      type: "event",
      event: "session.deleted",
      sessionKey
    });
  }
  
  return { success: true };
}

async function handleChatSend(params) {
  const { sessionKey, content, agentId = AGENT_ID, model = MODEL } = params || {};
  
  // Get or create session
  if (!conversationHistory.has(sessionKey)) {
    await handleSessionCreate({ agentId, sessionKey });
  }
  
  const messages = conversationHistory.get(sessionKey);
  
  // Add user message
  const userMessage = {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    role: "user",
    content: content,
    createdAt: new Date().toISOString()
  };
  messages.push(userMessage);
  
  // Get conversation history for context
  const recentMessages = messages.slice(-10); // Last 10 messages for context
  
  // Prepare messages for Hermes API
  const hermesMessages = [
    { role: "system", content: agentRegistry.get(agentId)?.systemPrompt || "You are a helpful AI agent." }
  ];
  
  for (const msg of recentMessages) {
    hermesMessages.push({
      role: msg.role,
      content: msg.content
    });
  }
  
  // Call Hermes API
  const hermesResponse = await hermesPost("/v1/chat/completions", {
    model: model,
    messages: hermesMessages,
    stream: false
  });
  
  const hermesResult = await readJsonBody(hermesResponse);
  
  if (hermesResponse.statusCode >= 400) {
    throw new Error(`Hermes API error: ${hermesResponse.statusCode}`);
  }
  
  const assistantContent = hermesResult.choices?.[0]?.message?.content || "";
  
  // Add assistant message
  const assistantMessage = {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    role: "assistant",
    content: assistantContent,
    createdAt: new Date().toISOString()
  };
  messages.push(assistantMessage);
  
  // Persist history
  await persistHistory();
  
  // Broadcast new message
  broadcastEvent({
    type: "event",
    event: "message.created",
    sessionKey,
    message: assistantMessage
  });
  
  return {
    messageId: assistantMessage.id,
    sessionKey,
    content: assistantContent
  };
}

async function handleChatAbort(params) {
  // Simplified - in a real implementation this would cancel active generations
  return { success: true };
}

async function handleConfigGet(params) {
  const { key } = params || {};
  
  // Return basic gateway config
  if (key === "gateway") {
    return {
      url: `ws://${require("node:os").hostname()}:${GATEWAY_PORT}`,
      token: HERMES_API_KEY || "",
      adapterType: "hermes"
    };
  }
  
  return {};
}

async function handleConfigSet(params) {
  // Configuration setting is not supported in this direct gateway
  return { success: false, message: "Configuration not mutable in direct gateway mode" };
}

async function handleConfigPatch(params) {
  // Configuration patching is not supported in this direct gateway
  return { success: false, message: "Configuration not mutable in direct gateway mode" };
}

// Event broadcasting
function broadcastEvent(event) {
  const message = JSON.stringify(event);
  for (const sendFn of activeSendEventFns) {
    try {
      sendFn(message);
    } catch (err) {
      // Remove broken send functions
      activeSendEventFns.delete(sendFn);
    }
  }
}

// Persist conversation history to disk
async function persistHistory() {
  try {
    const data = {};
    for (const [key, messages] of conversationHistory.entries()) {
      if (messages.length > 0) {
        data[key] = messages.map(msg => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt
        }));
      }
    }
    
    const historyDir = path.join(require("node:os").homedir(), ".hermes");
    fs.mkdirSync(historyDir, { recursive: true });
    const historyFile = path.join(historyDir, "clawd3d-history.json");
    fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn("[hermes-direct-gateway] Failed to persist history:", err);
  }
}

// Load conversation history from disk
function loadHistoryFromDisk() {
  try {
    const historyDir = path.join(require("node:os").homedir(), ".hermes");
    const historyFile = path.join(historyDir, "clawd3d-history.json");
    if (fs.existsSync(historyFile)) {
      const raw = fs.readFileSync(historyFile, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        for (const [key, messages] of Object.entries(data)) {
          if (Array.isArray(messages)) {
            conversationHistory.set(key, messages.map(msg => ({
              ...msg,
              createdAt: msg.createdAt || new Date().toISOString()
            })));
          }
        }
        console.log(`[hermes-direct-gateway] Loaded history for ${Object.keys(data).length} session(s).`);
      }
    }
  } catch (err) {
    console.warn("[hermes-direct-gateway] Could not load history:", err);
  }
}

// WebSocket server setup
function startWebSocketServer() {
  const wss = new WebSocketServer({
    port: GATEWAY_PORT,
    host: HOST,
    // Per-message deflate is off by default; set to true to enable
    // perMessageDeflate: false
  });

  wss.on("listening", () => {
    console.log(`[hermes-direct-gateway] WebSocket server listening on ${HOST}:${GATEWAY_PORT}`);
    
    // Show connection URLs
    const protocol = "ws"; // Will be wss if behind SSL proxy
    const hostForDisplay = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
    console.log(`[hermes-direct-gateway] Connect to: ${protocol}://${hostForDisplay}:${GATEWAY_PORT}`);
  });

  wss.on("connection", (ws, req) => {
    console.log(`[hermes-direct-gateway] New WebSocket connection from ${req.socket.remoteAddress}`);
    
    // Add broadcast function for this connection
    const sendFn = (message) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    };
    activeSendEventFns.add(sendFn);
    
    ws.on("message", (data) => {
      handleClaw3DMessage(ws, data.toString());
    });
    
    ws.on("close", () => {
      console.log(`[hermes-direct-gateway] WebSocket connection closed`);
      activeSendEventFns.delete(sendFn);
    });
    
    ws.on("error", (err) => {
      console.error(`[hermes-direct-gateway] WebSocket error:`, err);
      activeSendEventFns.delete(sendFn);
    });
    
    // Send hello message immediately upon connection
    ws.send(JSON.stringify({
      type: "hello",
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      version: "0.1.0",
      capabilities: [
        "agent.list", "agent.create", "agent.get", "agent.update", "agent.delete",
        "session.list", "session.create", "session.get", "session.update", "session.delete",
        "chat.send", "chat.abort",
        "config.get", "config.set", "config.patch"
      ]
    }));
  });

  wss.on("error", (err) => {
    console.error("[hermes-direct-gateway] WebSocket server error:", err);
  });

  return wss;
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[hermes-direct-gateway] Shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[hermes-direct-gateway] Shutting down gracefully...");
  process.exit(0);
});

// Start the gateway
function main() {
  // Load persisted history
  loadHistoryFromDisk();
  
  // Start WebSocket server
  const wss = startWebSocketServer();
  
  console.log(`[hermes-direct-gateway] Hermes Direct Gateway is ready!`);
  console.log(`[hermes-direct-gateway] Configure Claw3D to connect to: ws://${HOST}:${GATEWAY_PORT}`);
  console.log(`[hermes-direct-gateway] For WSS access, place behind SSL proxy (like NGINX)`);
}

main();