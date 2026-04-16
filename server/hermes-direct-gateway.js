"use strict";

/**
 * Direct Hermes WebSocket Gateway for Claw3D
 *
 * This gateway speaks the full OpenClaw gateway protocol (v3),
 * translating WebSocket JSON-RPC frames from Claw3D Studio into
 * Hermes HTTP API calls and returning sensible defaults for methods
 * that have no Hermes equivalent.
 *
 * Protocol reference: discovered from Claw3D client source
 *   GatewayBrowserClient.ts, GatewayClient.ts, agentConfig.ts,
 *   agentFiles.ts, execApprovals.ts, and feature-level callers.
 */

const { Buffer } = require("node:buffer");
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { WebSocketServer } = require("ws");

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------
function loadDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const HERMES_API_URL = (process.env.HERMES_API_URL || "http://localhost:8644").replace(/\/$/, "");
const HERMES_API_KEY = process.env.HERMES_API_KEY || "";
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "18789", 10);
const HOST = process.env.HOST || "0.0.0.0";

const AGENT_ID = "hermes";
const AGENT_NAME = process.env.HERMES_AGENT_NAME || "Hermes";
const MODEL = process.env.HERMES_MODEL || "hermes";

console.log(`[hermes-direct-gateway] Starting Hermes WebSocket Gateway`);
console.log(`[hermes-direct-gateway] Hermes API: ${HERMES_API_URL}`);
console.log(`[hermes-direct-gateway] Gateway Port: ${GATEWAY_PORT}`);
console.log(`[hermes-direct-gateway] Host: ${HOST}`);

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const conversationHistory = new Map(); // sessionKey -> messages[]
const agentRegistry = new Map();       // agentId -> agentInfo
const agentFiles = new Map();          // `${agentId}:${name}` -> content string
const activeSendEventFns = new Set();
const tasks = new Map();               // taskId -> task record
const cronJobs = new Map();            // cronId -> cron record
let configData = {};                   // openclaw.json equivalent
let configHash = crypto.randomUUID();
const configPath = path.join(os.homedir(), ".hermes", "openclaw.json");
const execApprovalsData = { version: 1, agents: {} };
let execApprovalsHash = crypto.randomUUID();
let seqCounter = 0;

// Initialize main Hermes agent
const mainAgentInfo = {
  id: AGENT_ID,
  name: AGENT_NAME,
  model: MODEL,
  role: "Orchestrator",
  workspace: path.join(os.homedir(), ".hermes", "workspace"),
  systemPrompt: `You are ${AGENT_NAME}, an AI agent in the Claw3D 3D office. You can help with various tasks and converse with users.`,
  sessionKey: `agent:${AGENT_ID}:main`,
};
agentRegistry.set(AGENT_ID, mainAgentInfo);
conversationHistory.set(mainAgentInfo.sessionKey, []);

// ---------------------------------------------------------------------------
// Hermes HTTP API helpers
// ---------------------------------------------------------------------------
function hermesPost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const urlStr = HERMES_API_URL + apiPath;
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const transport = url.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) };
    if (HERMES_API_KEY) headers["Authorization"] = `Bearer ${HERMES_API_KEY}`;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""),
        method: "POST",
        headers,
      },
      resolve
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function hermesGet(apiPath) {
  return new Promise((resolve, reject) => {
    const urlStr = HERMES_API_URL + apiPath;
    let url;
    try { url = new URL(urlStr); } catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }
    const transport = url.protocol === "https:" ? https : http;
    const headers = {};
    if (HERMES_API_KEY) headers["Authorization"] = `Bearer ${HERMES_API_KEY}`;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""),
        method: "GET",
        headers,
      },
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

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }

// ---------------------------------------------------------------------------
// Event broadcasting
// ---------------------------------------------------------------------------
function broadcastEvent(event) {
  const message = JSON.stringify(event);
  for (const sendFn of activeSendEventFns) {
    try { sendFn(message); } catch { activeSendEventFns.delete(sendFn); }
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
function persistHistory() {
  try {
    const data = {};
    for (const [key, messages] of conversationHistory.entries()) {
      if (messages.length > 0) {
        data[key] = messages.map((msg) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt,
        }));
      }
    }
    const historyDir = path.join(os.homedir(), ".hermes");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, "clawd3d-history.json"), JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn("[hermes-direct-gateway] Failed to persist history:", err.message);
  }
}

function loadHistoryFromDisk() {
  try {
    const historyFile = path.join(os.homedir(), ".hermes", "clawd3d-history.json");
    if (fs.existsSync(historyFile)) {
      const raw = fs.readFileSync(historyFile, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        for (const [key, messages] of Object.entries(data)) {
          if (Array.isArray(messages)) {
            conversationHistory.set(key, messages.map((msg) => ({
              ...msg,
              createdAt: msg.createdAt || now(),
            })));
          }
        }
        console.log(`[hermes-direct-gateway] Loaded history for ${Object.keys(data).length} session(s).`);
      }
    }
  } catch (err) {
    console.warn("[hermes-direct-gateway] Could not load history:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Build the list of all supported methods
// ---------------------------------------------------------------------------
const ALL_METHODS = [
  "connect",
  "agents.list", "agents.create", "agents.update", "agents.delete",
  "agents.files.get", "agents.files.set",
  "sessions.list", "sessions.patch", "sessions.preview", "sessions.reset", "sessions.usage",
  "chat.send", "chat.abort", "chat.history",
  "config.get", "config.set", "config.patch",
  "status", "wake",
  "agent.wait",
  "exec.approvals.get", "exec.approvals.set", "exec.approval.resolve",
  "models.list",
  "tasks.list", "tasks.create", "tasks.update", "tasks.delete",
  "usage.cost",
  "skills.status", "skills.install", "skills.update",
  "cron.list", "cron.add", "cron.remove", "cron.run",
];

const ALL_EVENTS = [
  "connect.challenge",
  "agent", "chat", "presence", "heartbeat", "object",
  "playbook_triggered", "task_archived", "task_deleted",
  "exec.approval.requested",
];

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

// 1. connect  ---------------------------------------------------------------
async function handleConnect(params) {
  // Return hello-ok shaped payload
  return {
    type: "hello-ok",
    protocol: 3,
    adapterType: "hermes",
    features: {
      methods: ALL_METHODS,
      events: ALL_EVENTS,
    },
    snapshot: {
      health: {
        defaultAgentId: AGENT_ID,
        agents: Array.from(agentRegistry.values()).map((a) => ({
          agentId: a.id,
          name: a.name,
          isDefault: a.id === AGENT_ID,
        })),
      },
      sessionDefaults: {
        mainKey: "main",
        scope: "default",
      },
    },
    auth: {
      deviceToken: params?.auth?.token || params?.device?.id || "",
      role: "operator",
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
      issuedAtMs: nowMs(),
    },
    policy: { tickIntervalMs: 30000 },
  };
}

// 2. agents.list  -----------------------------------------------------------
async function handleAgentsList() {
  const agents = [];
  for (const [, info] of agentRegistry.entries()) {
    agents.push({
      id: info.id,
      name: info.name,
      identity: {
        name: info.name,
        theme: "default",
        emoji: info.id === AGENT_ID ? "🏛️" : "🤖",
      },
    });
  }
  return {
    defaultId: AGENT_ID,
    mainKey: "main",
    scope: "default",
    agents,
  };
}

// 3. agents.create  ---------------------------------------------------------
async function handleAgentsCreate(params) {
  const { name, workspace } = params || {};
  const slug = (name || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `agent-${Date.now()}`;
  const agentId = slug;
  const agentInfo = {
    id: agentId,
    name: name || `Agent ${agentId}`,
    model: MODEL,
    role: "Specialist",
    workspace: workspace || path.join(os.homedir(), ".hermes", `workspace-${slug}`),
    systemPrompt: `You are ${name || agentId}, a helpful AI agent.`,
    sessionKey: `agent:${agentId}:main`,
  };
  agentRegistry.set(agentId, agentInfo);
  conversationHistory.set(agentInfo.sessionKey, []);

  broadcastEvent({
    type: "event",
    event: "agent",
    seq: ++seqCounter,
    payload: { action: "created", agentId: agentInfo.id, name: agentInfo.name },
  });

  return { ok: true, agentId: agentInfo.id, name: agentInfo.name, workspace: agentInfo.workspace };
}

// 4. agents.update  ---------------------------------------------------------
async function handleAgentsUpdate(params) {
  const { agentId, name } = params || {};
  const info = agentRegistry.get(agentId);
  if (!info) throw new Error(`Agent not found: ${agentId}`);
  if (name !== undefined) info.name = name;
  return { ok: true, agentId: info.id, name: info.name };
}

// 5. agents.delete  ---------------------------------------------------------
async function handleAgentsDelete(params) {
  const { agentId } = params || {};
  if (!agentRegistry.has(agentId)) throw new Error(`Agent not found: ${agentId}`);
  if (agentId === AGENT_ID) throw new Error("Cannot delete the main Hermes agent");
  agentRegistry.delete(agentId);
  // Clean up sessions
  for (const key of conversationHistory.keys()) {
    if (key.startsWith(`agent:${agentId}:`)) conversationHistory.delete(key);
  }
  broadcastEvent({
    type: "event",
    event: "agent",
    seq: ++seqCounter,
    payload: { action: "deleted", agentId },
  });
  return { ok: true, removedBindings: 0 };
}

// 6. agents.files.get  ------------------------------------------------------
async function handleAgentsFilesGet(params) {
  const { agentId, name } = params || {};
  const key = `${agentId}:${name}`;
  const content = agentFiles.get(key);
  const info = agentRegistry.get(agentId);
  if (content !== undefined) {
    return {
      workspace: info?.workspace || null,
      file: { missing: false, content, path: `${info?.workspace || ""}/${name}` },
    };
  }
  return {
    workspace: info?.workspace || null,
    file: { missing: true, content: "", path: null },
  };
}

// 7. agents.files.set  ------------------------------------------------------
async function handleAgentsFilesSet(params) {
  const { agentId, name, content } = params || {};
  const key = `${agentId}:${name}`;
  agentFiles.set(key, content || "");
  return { ok: true };
}

// 8. sessions.list  ---------------------------------------------------------
async function handleSessionsList(params) {
  const { agentId, limit = 50 } = params || {};
  const sessions = [];
  for (const [sessionKey, messages] of conversationHistory.entries()) {
    if (agentId) {
      const match = sessionKey.match(/^agent:([^:]+):/);
      if (match && match[1] !== agentId) continue;
    }
    sessions.push({
      key: sessionKey,
      updatedAt: messages.length > 0 ? nowMs() : null,
      origin: { label: null },
    });
    if (sessions.length >= limit) break;
  }
  return { sessions };
}

// 9. sessions.patch  --------------------------------------------------------
async function handleSessionsPatch(params) {
  const { key } = params || {};
  if (!key) throw new Error("Session key is required.");
  // Accept the patch but Hermes doesn't really use per-session model settings
  return {
    ok: true,
    key,
    entry: {
      thinkingLevel: params?.thinkingLevel || undefined,
    },
    resolved: {
      modelProvider: "hermes",
      model: MODEL,
    },
  };
}

// 10. sessions.preview  -----------------------------------------------------
async function handleSessionsPreview(params) {
  const { keys = [], limit = 8, maxChars = 240 } = params || {};
  const previews = [];
  for (const key of keys) {
    const messages = conversationHistory.get(key) || [];
    const recent = messages.slice(-limit);
    const items = recent.map((msg) => ({
      role: msg.role,
      text: (msg.content || "").slice(0, maxChars),
    }));
    previews.push({
      key,
      status: "idle",
      items,
    });
  }
  return { previews };
}

// 11. sessions.reset  -------------------------------------------------------
async function handleSessionsReset(params) {
  const { key } = params || {};
  if (key && conversationHistory.has(key)) {
    conversationHistory.set(key, []);
    persistHistory();
  }
  return { ok: true };
}

// 12. sessions.usage  -------------------------------------------------------
async function handleSessionsUsage(params) {
  // Stub – Hermes doesn't track per-session usage
  return { sessions: [] };
}

// 13. chat.send  ------------------------------------------------------------
async function handleChatSend(params) {
  const {
    sessionKey,
    message,
    content,
    agentId: requestedAgentId,
    deliver = true,
    idempotencyKey,
  } = params || {};

  const userContent = message || content || "";
  const resolvedAgentId = requestedAgentId ||
    (sessionKey ? (sessionKey.match(/^agent:([^:]+):/) || [])[1] : null) ||
    AGENT_ID;
  const resolvedSessionKey = sessionKey || `agent:${resolvedAgentId}:main`;
  const runId = idempotencyKey || uuid();

  // Get or create session
  if (!conversationHistory.has(resolvedSessionKey)) {
    conversationHistory.set(resolvedSessionKey, []);
  }
  const messages = conversationHistory.get(resolvedSessionKey);

  // Add user message
  const userMessage = {
    id: `msg_${uuid()}`,
    role: "user",
    content: userContent,
    createdAt: now(),
  };
  messages.push(userMessage);

  // Build context for Hermes
  const recentMessages = messages.slice(-10);
  const agentInfo = agentRegistry.get(resolvedAgentId);
  const hermesMessages = [
    { role: "system", content: agentInfo?.systemPrompt || "You are a helpful AI agent." },
  ];
  for (const msg of recentMessages) {
    hermesMessages.push({ role: msg.role, content: msg.content });
  }

  // Call Hermes API
  let assistantContent = "";
  try {
    const hermesResponse = await hermesPost("/v1/chat/completions", {
      model: agentInfo?.model || MODEL,
      messages: hermesMessages,
      stream: false,
    });
    const hermesResult = await readJsonBody(hermesResponse);
    if (hermesResponse.statusCode >= 400) {
      throw new Error(`Hermes API error: ${hermesResponse.statusCode}`);
    }
    assistantContent = hermesResult.choices?.[0]?.message?.content || "";
  } catch (err) {
    console.error("[hermes-direct-gateway] Hermes API error:", err.message);
    assistantContent = `[Gateway error: ${err.message}]`;
  }

  // Add assistant message
  const assistantMessage = {
    id: `msg_${uuid()}`,
    role: "assistant",
    content: assistantContent,
    createdAt: now(),
  };
  messages.push(assistantMessage);
  persistHistory();

  // Broadcast chat event
  broadcastEvent({
    type: "event",
    event: "chat",
    seq: ++seqCounter,
    payload: {
      sessionKey: resolvedSessionKey,
      message: assistantMessage,
      runId,
    },
  });

  return {
    ok: true,
    runId,
    messageId: assistantMessage.id,
    sessionKey: resolvedSessionKey,
    content: assistantContent,
  };
}

// 14. chat.abort  -----------------------------------------------------------
async function handleChatAbort(_params) {
  return { ok: true };
}

// 15. chat.history  ---------------------------------------------------------
async function handleChatHistory(params) {
  const { sessionKey, limit = 50 } = params || {};
  const messages = conversationHistory.get(sessionKey) || [];
  const recent = messages.slice(-limit);
  return {
    sessionKey: sessionKey || "",
    messages: recent.map((msg) => ({
      id: msg.id || uuid(),
      role: msg.role,
      content: msg.content || "",
      createdAt: msg.createdAt || now(),
    })),
  };
}

// 16. config.get  -----------------------------------------------------------
async function handleConfigGet(_params) {
  return {
    config: configData,
    hash: configHash,
    exists: Object.keys(configData).length > 0,
    path: configPath,
  };
}

// 17. config.set  -----------------------------------------------------------
async function handleConfigSet(params) {
  const { raw, baseHash } = params || {};
  if (baseHash && baseHash !== configHash && Object.keys(configData).length > 0) {
    throw Object.assign(new Error("Config changed since last load; re-run config.get."), { code: "CONFLICT" });
  }
  try {
    configData = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
  } catch {
    configData = {};
  }
  configHash = crypto.randomUUID();
  return { ok: true, hash: configHash };
}

// 18. config.patch  ---------------------------------------------------------
async function handleConfigPatch(params) {
  const { raw, baseHash } = params || {};
  if (baseHash && baseHash !== configHash && Object.keys(configData).length > 0) {
    throw Object.assign(new Error("Config changed since last load; re-run config.get."), { code: "CONFLICT" });
  }
  let patch = {};
  try {
    patch = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
  } catch {
    patch = {};
  }
  // Deep merge (shallow 2 levels)
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && configData[k] && typeof configData[k] === "object") {
      configData[k] = { ...configData[k], ...v };
    } else {
      configData[k] = v;
    }
  }
  configHash = crypto.randomUUID();
  return { ok: true, hash: configHash };
}

// 19. status  ---------------------------------------------------------------
async function handleStatus(_params) {
  const agents = [];
  for (const [, info] of agentRegistry.entries()) {
    agents.push({
      agentId: info.id,
      name: info.name,
      enabled: true,
      every: "30m",
      everyMs: 1800000,
    });
  }
  return {
    heartbeat: { agents },
    uptime: process.uptime(),
    version: "0.1.0",
    adapterType: "hermes",
  };
}

// 20. wake  -----------------------------------------------------------------
async function handleWake(params) {
  // Trigger a heartbeat / no-op for Hermes
  return { ok: true };
}

// 21. agent.wait  -----------------------------------------------------------
async function handleAgentWait(params) {
  const { runId, timeoutMs = 30000 } = params || {};
  // The agent run completes synchronously in our chat.send, so just return immediately
  return { ok: true, runId, status: "completed" };
}

// 22. exec.approvals.get  ---------------------------------------------------
async function handleExecApprovalsGet(_params) {
  return {
    path: path.join(os.homedir(), ".hermes", "exec-approvals.json"),
    exists: true,
    hash: execApprovalsHash,
    file: execApprovalsData,
  };
}

// 23. exec.approvals.set  ---------------------------------------------------
async function handleExecApprovalsSet(params) {
  const { file, baseHash } = params || {};
  if (baseHash && baseHash !== execApprovalsHash) {
    throw Object.assign(new Error("Exec approvals changed since last load; re-run exec.approvals.get."), { code: "CONFLICT" });
  }
  if (file) {
    Object.assign(execApprovalsData, file);
  }
  execApprovalsHash = crypto.randomUUID();
  return { ok: true, hash: execApprovalsHash };
}

// 24. exec.approval.resolve  ------------------------------------------------
async function handleExecApprovalResolve(params) {
  const { id, decision } = params || {};
  // In Hermes mode there's no sandboxed execution needing approval,
  // so just acknowledge.
  return { ok: true, id, decision };
}

// 25. models.list  ----------------------------------------------------------
async function handleModelsList(_params) {
  // Try to query Hermes for available models, fall back to defaults
  try {
    const res = await hermesGet("/v1/models");
    const body = await readJsonBody(res);
    if (Array.isArray(body?.data)) {
      return {
        models: body.data.map((m) => ({
          id: m.id || "hermes",
          name: m.id || "Hermes",
          provider: "hermes",
          contextWindow: 128000,
          reasoning: false,
        })),
      };
    }
  } catch { /* fall through */ }
  return {
    models: [
      { id: MODEL, name: AGENT_NAME, provider: "hermes", contextWindow: 128000, reasoning: false },
    ],
  };
}

// 26. tasks.list  -----------------------------------------------------------
async function handleTasksList(_params) {
  return { tasks: Array.from(tasks.values()) };
}

// 27. tasks.create  ---------------------------------------------------------
async function handleTasksCreate(params) {
  const taskId = uuid();
  const task = {
    id: taskId,
    ...params,
    status: "pending",
    createdAt: now(),
    updatedAt: now(),
  };
  tasks.set(taskId, task);
  return task;
}

// 28. tasks.update  ---------------------------------------------------------
async function handleTasksUpdate(params) {
  const { id } = params || {};
  const task = tasks.get(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  Object.assign(task, params, { updatedAt: now() });
  return task;
}

// 29. tasks.delete  ---------------------------------------------------------
async function handleTasksDelete(params) {
  const { id } = params || {};
  const existed = tasks.delete(id);
  return { ok: true, removed: existed };
}

// 30. usage.cost  -----------------------------------------------------------
async function handleUsageCost(_params) {
  // Stub — Hermes doesn't track billing
  return {
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    daily: [],
  };
}

// 31. skills.status  --------------------------------------------------------
async function handleSkillsStatus(params) {
  return { skills: [], agentId: params?.agentId || AGENT_ID };
}

// 32. skills.install  -------------------------------------------------------
async function handleSkillsInstall(params) {
  return { ok: true, skillKey: params?.packageId || "unknown", installed: true };
}

// 33. skills.update  --------------------------------------------------------
async function handleSkillsUpdate(params) {
  return { ok: true, skillKey: params?.packageId || "unknown", updated: true };
}

// 34. cron.list  ------------------------------------------------------------
async function handleCronList(_params) {
  // Return properly shaped CronJobSummary objects
  const jobs = Array.from(cronJobs.values()).map((job) => ({
    id: job.id,
    name: job.name || "Untitled Job",
    agentId: job.agentId || AGENT_ID,
    sessionKey: job.sessionKey || null,
    description: job.description || "",
    enabled: job.enabled !== false,
    deleteAfterRun: job.deleteAfterRun || false,
    updatedAtMs: job.updatedAtMs || Date.now(),
    schedule: job.schedule || { kind: "every", everyMs: 3600000 },
    sessionTarget: job.sessionTarget || "main",
    wakeMode: job.wakeMode || "next-heartbeat",
    payload: job.payload || { kind: "systemEvent", text: job.command || "" },
    state: job.state || {
      nextRunAtMs: undefined,
      runningAtMs: undefined,
      lastRunAtMs: undefined,
      lastStatus: undefined,
      lastError: undefined,
      lastDurationMs: undefined,
    },
    delivery: job.delivery || undefined,
  }));
  return { jobs };
}

// 35. cron.add  -------------------------------------------------------------
async function handleCronAdd(params) {
  const cronId = uuid();
  const job = {
    id: cronId,
    name: params?.name || "Untitled Job",
    agentId: params?.agentId || AGENT_ID,
    sessionKey: params?.sessionKey || null,
    description: params?.description || "",
    enabled: params?.enabled !== false,
    deleteAfterRun: params?.deleteAfterRun || false,
    updatedAtMs: Date.now(),
    schedule: params?.schedule || { kind: "every", everyMs: 3600000 },
    sessionTarget: params?.sessionTarget || "main",
    wakeMode: params?.wakeMode || "next-heartbeat",
    payload: params?.payload || { kind: "systemEvent", text: "" },
    state: {
      nextRunAtMs: undefined,
      runningAtMs: undefined,
      lastRunAtMs: undefined,
      lastStatus: undefined,
      lastError: undefined,
      lastDurationMs: undefined,
    },
    delivery: params?.delivery || undefined,
  };
  cronJobs.set(cronId, job);
  return job;
}

// 36. cron.remove  ----------------------------------------------------------
async function handleCronRemove(params) {
  const { id } = params || {};
  const existed = cronJobs.delete(id);
  return { ok: true, removed: existed };
}

// 37. cron.run  -------------------------------------------------------------
async function handleCronRun(params) {
  return { ok: true, id: params?.id, status: "triggered" };
}

// ---------------------------------------------------------------------------
// Method router
// ---------------------------------------------------------------------------
const METHOD_MAP = {
  "connect":               handleConnect,
  "agents.list":           handleAgentsList,
  "agents.create":         handleAgentsCreate,
  "agents.update":         handleAgentsUpdate,
  "agents.delete":         handleAgentsDelete,
  "agents.files.get":      handleAgentsFilesGet,
  "agents.files.set":      handleAgentsFilesSet,
  "sessions.list":         handleSessionsList,
  "sessions.patch":        handleSessionsPatch,
  "sessions.preview":      handleSessionsPreview,
  "sessions.reset":        handleSessionsReset,
  "sessions.usage":        handleSessionsUsage,
  "chat.send":             handleChatSend,
  "chat.abort":            handleChatAbort,
  "chat.history":          handleChatHistory,
  "config.get":            handleConfigGet,
  "config.set":            handleConfigSet,
  "config.patch":          handleConfigPatch,
  "status":                handleStatus,
  "wake":                  handleWake,
  "agent.wait":            handleAgentWait,
  "exec.approvals.get":    handleExecApprovalsGet,
  "exec.approvals.set":    handleExecApprovalsSet,
  "exec.approval.resolve": handleExecApprovalResolve,
  "models.list":           handleModelsList,
  "tasks.list":            handleTasksList,
  "tasks.create":          handleTasksCreate,
  "tasks.update":          handleTasksUpdate,
  "tasks.delete":          handleTasksDelete,
  "usage.cost":            handleUsageCost,
  "skills.status":         handleSkillsStatus,
  "skills.install":        handleSkillsInstall,
  "skills.update":         handleSkillsUpdate,
  "cron.list":             handleCronList,
  "cron.add":              handleCronAdd,
  "cron.remove":           handleCronRemove,
  "cron.run":              handleCronRun,
};

// ---------------------------------------------------------------------------
// WebSocket message handler
// ---------------------------------------------------------------------------
async function handleClaw3DMessage(ws, message) {
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    ws.send(JSON.stringify({
      type: "res",
      id: "unknown",
      ok: false,
      error: { code: "INVALID_JSON", message: "Invalid JSON format" },
    }));
    return;
  }

  const { type, id: msgId, method, params } = parsed;

  if (type === "req") {
    await handleRequest(ws, msgId, method, params || {});
  } else if (type !== "res") {
    ws.send(JSON.stringify({
      type: "res",
      id: msgId || null,
      ok: false,
      error: { code: "UNKNOWN_TYPE", message: `Unknown message type: ${type}` },
    }));
  }
}

async function handleRequest(ws, msgId, method, params) {
  const handler = METHOD_MAP[method];
  if (!handler) {
    console.warn(`[hermes-direct-gateway] Unknown method: ${method}`);
    ws.send(JSON.stringify({
      type: "res",
      id: msgId,
      ok: false,
      error: { code: "UNKNOWN_METHOD", message: `Unknown method: ${method}` },
    }));
    return;
  }

  try {
    const result = await handler(params);
    ws.send(JSON.stringify({
      type: "res",
      id: msgId,
      ok: true,
      payload: result,
    }));
  } catch (error) {
    console.error(`[hermes-direct-gateway] Error handling ${method}:`, error.message);
    ws.send(JSON.stringify({
      type: "res",
      id: msgId,
      ok: false,
      error: {
        code: error.code || "INTERNAL_ERROR",
        message: error.message || "Unknown error",
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
function startWebSocketServer() {
  const wss = new WebSocketServer({ port: GATEWAY_PORT, host: HOST });

  wss.on("listening", () => {
    console.log(`[hermes-direct-gateway] WebSocket server listening on ${HOST}:${GATEWAY_PORT}`);
    const hostForDisplay = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
    console.log(`[hermes-direct-gateway] Connect to: ws://${hostForDisplay}:${GATEWAY_PORT}`);
    console.log(`[hermes-direct-gateway] Supported methods (${ALL_METHODS.length}): ${ALL_METHODS.join(", ")}`);
  });

  wss.on("connection", (ws, req) => {
    console.log(`[hermes-direct-gateway] New WebSocket connection from ${req.socket.remoteAddress}`);

    const sendFn = (message) => {
      if (ws.readyState === 1 /* WebSocket.OPEN */) {
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
      console.error(`[hermes-direct-gateway] WebSocket error:`, err.message);
      activeSendEventFns.delete(sendFn);
    });

    // NOTE: We do NOT send a hello frame on connection.
    // The OpenClaw protocol v3 requires the client to send a "connect"
    // request first (possibly after a connect.challenge exchange), and the
    // server responds with the hello-ok payload in the "res" frame.
    // Sending an unsolicited "hello" frame would confuse the client.
  });

  wss.on("error", (err) => {
    console.error("[hermes-direct-gateway] WebSocket server error:", err);
  });

  return wss;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
process.on("SIGINT", () => {
  console.log("\n[hermes-direct-gateway] Shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[hermes-direct-gateway] Shutting down gracefully...");
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  loadHistoryFromDisk();
  startWebSocketServer();
  console.log(`[hermes-direct-gateway] Hermes Direct Gateway is ready!`);
  console.log(`[hermes-direct-gateway] Configure Claw3D to connect to: ws://${HOST}:${GATEWAY_PORT}`);
}

main();
