"use strict";

const { WebSocketServer } = require("ws");

const workspaceClients   = new Map();
const userWorkspaceIndex = new Map();

function init(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url     = new URL(req.url, "http://" + req.headers.host);
    const userUid = url.searchParams.get("userUid");
    if (!userUid) { ws.close(1008, "userUid required"); return; }
    ws.userUid = userUid;
    ws.isAlive  = true;
    ws.on("pong",  () => { ws.isAlive = true; });
    ws.on("close", () => _removeClient(ws));
    ws.on("error", (err) => console.error("[WS] uid=" + userUid + ":", err.message));
    console.log("[WS] Connected: userUid=" + userUid);
  });

  setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  return wss;
}

function registerUserWorkspace(userUid, workspaceId, ws) {
  userWorkspaceIndex.set(userUid, workspaceId);
  if (!workspaceClients.has(workspaceId)) workspaceClients.set(workspaceId, new Set());
  workspaceClients.get(workspaceId).add(ws);
}

function _removeClient(ws) {
  const wid = userWorkspaceIndex.get(ws.userUid);
  if (wid) workspaceClients.get(wid)?.delete(ws);
  userWorkspaceIndex.delete(ws.userUid);
}

function broadcastToWorkspace(workspaceId, payload) {
  const clients = workspaceClients.get(workspaceId);
  if (!clients || clients.size === 0) return;
  const message = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(message, (err) => { if (err) console.error("[WS] Send error:", err.message); });
    }
  }
}

module.exports = { init, registerUserWorkspace, broadcastToWorkspace };
