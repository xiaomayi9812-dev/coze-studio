#!/usr/bin/env node
/**
 * Phase 1: OpenAI-compatible sidecar for Coze.
 * Maps POST /v1/chat/completions to `cursor-agent --print --mode ask`.
 * Text + SSE only. Function calling is Phase 2.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PROXY_PORT || 8787);
const HOST = process.env.PROXY_HOST || "0.0.0.0";
const DEFAULT_MODEL = process.env.CURSOR_PROXY_MODEL || "composer-2.5";
const AGENT_BIN = process.env.CURSOR_AGENT_BIN || "cursor-agent";
const MAX_CONCURRENCY = Number(process.env.PROXY_MAX_CONCURRENCY || 1);
const REQUEST_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 180000);

let inflight = 0;
const waiters = [];

function requireApiKey() {
  const key = process.env.CURSOR_API_KEY || "";
  if (!key) {
    throw new Error(
      "CURSOR_API_KEY is empty. Source ~/.bashrc or export it before starting the proxy.",
    );
  }
  return key;
}

function acquireSlot() {
  if (inflight < MAX_CONCURRENCY) {
    inflight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
  }).then(() => {
    inflight += 1;
  });
}

function releaseSlot() {
  inflight = Math.max(0, inflight - 1);
  const next = waiters.shift();
  if (next) {
    next();
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid json: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function contentToText(content) {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part?.type === "text") {
          return part.text || "";
        }
        if (part?.text) {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return String(content);
}

function renderMessages(messages = []) {
  return messages
    .map((msg) => {
      const role = msg.role || "user";
      const text = contentToText(msg.content);
      if (role === "tool") {
        const name = msg.name || msg.tool_call_id || "tool";
        return `[tool ${name}]\n${text}`;
      }
      if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const calls = msg.tool_calls
          .map((c) => `${c.function?.name || "fn"}(${c.function?.arguments || "{}"})`)
          .join("; ");
        return `[assistant]\n${text}\n[tool_calls] ${calls}`;
      }
      return `[${role}]\n${text}`;
    })
    .filter((block) => block.trim())
    .join("\n\n");
}

function extractTextFromAgentEvent(evt) {
  if (!evt || typeof evt !== "object") {
    return "";
  }
  if (typeof evt.text === "string" && (evt.type === "text-delta" || evt.type === "assistant_delta")) {
    return evt.text;
  }
  if (evt.type === "assistant" && evt.message) {
    return contentToText(evt.message.content);
  }
  if (evt.type === "result" && typeof evt.result === "string") {
    return evt.result;
  }
  if (evt.event?.delta?.text) {
    return evt.event.delta.text;
  }
  if (evt.delta?.text) {
    return evt.delta.text;
  }
  return "";
}

function spawnAgent({ prompt, model, stream }) {
  const cwd = mkdtempSync(join(tmpdir(), "cursor-openai-proxy-"));
  const args = [
    "--print",
    "--mode",
    "ask",
    "--trust",
    "--model",
    model,
    "--output-format",
    stream ? "stream-json" : "text",
  ];
  if (stream) {
    args.push("--stream-partial-output");
  }
  args.push(prompt);

  const child = spawn(AGENT_BIN, args, {
    cwd,
    env: {
      ...process.env,
      CURSOR_API_KEY: requireApiKey(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const cleanup = () => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  child.on("close", cleanup);
  child.on("error", cleanup);
  return child;
}

function runAgentCollect({ prompt, model }) {
  return new Promise((resolve, reject) => {
    const child = spawnAgent({ prompt, model, stream: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`cursor-agent timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    child.stdout.on("data", (buf) => {
      stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`cursor-agent exit ${code}: ${stderr || stdout}`.trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function listModels() {
  return new Promise((resolve, reject) => {
    const child = spawn(AGENT_BIN, ["--list-models", "--print"], {
      env: {
        ...process.env,
        CURSOR_API_KEY: requireApiKey(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf) => {
      stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`list-models failed: ${stderr || stdout}`.trim()));
        return;
      }
      const models = [];
      for (const line of stdout.split("\n")) {
        const m = line.match(/^([a-zA-Z0-9._-]+)\s+-\s+/);
        if (m) {
          models.push({
            id: m[1],
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "cursor",
          });
        }
      }
      if (!models.find((x) => x.id === DEFAULT_MODEL)) {
        models.unshift({
          id: DEFAULT_MODEL,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "cursor",
        });
      }
      resolve(models);
    });
  });
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleChat(req, res, body) {
  const model = body.model || DEFAULT_MODEL;
  const prompt = renderMessages(body.messages);
  if (!prompt.trim()) {
    sendJson(res, 400, { error: { message: "messages is empty" } });
    return;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    sendJson(res, 400, {
      error: {
        message:
          "Phase 1 proxy does not support tools/function calling yet. Set Coze capability.function_call=false.",
      },
    });
    return;
  }

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  await acquireSlot();
  try {
    if (body.stream) {
      await new Promise((resolve) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        });

        const child = spawnAgent({ prompt, model, stream: true });
        let buffer = "";
        let emitted = "";
        let finished = false;

        const finish = (reason, errMsg) => {
          if (finished) {
            return;
          }
          finished = true;
          if (errMsg) {
            writeSse(res, { error: { message: errMsg } });
          }
          writeSse(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: reason }],
          });
          res.write("data: [DONE]\n\n");
          res.end();
          resolve();
        };

        const emitDelta = (text) => {
          if (!text) {
            return;
          }
          let piece = text;
          if (emitted && text.startsWith(emitted)) {
            piece = text.slice(emitted.length);
            emitted = text;
          } else if (emitted && emitted.endsWith(text)) {
            return;
          } else {
            emitted += text;
          }
          if (!piece) {
            return;
          }
          writeSse(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          });
        };

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish("stop", `cursor-agent timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }, REQUEST_TIMEOUT_MS);

        req.on("close", () => {
          child.kill("SIGTERM");
        });

        child.stdout.on("data", (buf) => {
          buffer += buf.toString("utf8");
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) {
              continue;
            }
            try {
              emitDelta(extractTextFromAgentEvent(JSON.parse(line)));
            } catch {
              emitDelta(line);
            }
          }
        });

        let stderr = "";
        child.stderr.on("data", (buf) => {
          stderr += buf.toString("utf8");
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (buffer.trim()) {
            try {
              emitDelta(extractTextFromAgentEvent(JSON.parse(buffer.trim())));
            } catch {
              emitDelta(buffer.trim());
            }
          }
          if (code !== 0 && !emitted) {
            finish("stop", `cursor-agent exit ${code}: ${stderr}`.trim());
            return;
          }
          finish("stop");
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          finish("stop", err.message);
        });
      });
      return;
    }

    const text = await runAgentCollect({ prompt, model });
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } finally {
    releaseSlot();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      sendJson(res, 200, {
        ok: true,
        phase: 1,
        model: DEFAULT_MODEL,
        has_key: Boolean(process.env.CURSOR_API_KEY),
      });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      const data = await listModels();
      sendJson(res, 200, { object: "list", data });
      return;
    }
    if (
      req.method === "POST" &&
      (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
    ) {
      const body = await readBody(req);
      await handleChat(req, res, body);
      return;
    }
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: err.message || String(err) } });
    }
  }
});

requireApiKey();
server.listen(PORT, HOST, () => {
  console.log(
    `[cursor-openai-proxy] phase1 listening on http://${HOST}:${PORT} default_model=${DEFAULT_MODEL}`,
  );
});
