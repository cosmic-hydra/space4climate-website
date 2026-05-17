import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SERVER_INFO = {
  name: "opencode-mcp",
  version: "1.0.0",
};

const WORKFLOW_ID = process.env.OPENCODE_WORKFLOW_ID || "opencode.yml";
const OWNER = process.env.GITHUB_OWNER || process.env.GH_OWNER || "";
const REPO = process.env.GITHUB_REPO || process.env.GH_REPO || "";
const DEFAULT_MODEL = process.env.OPENCODE_DEFAULT_MODEL || "opencode-default-model";
const MAX_PROMPT_LENGTH = Number(process.env.OPENCODE_MAX_PROMPT_LENGTH || 12000);

let readBuffer = Buffer.alloc(0);

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  process.stdout.write(Buffer.concat([header, payload]));
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function sendToolError(id, message) {
  sendResult(id, {
    content: [{ type: "text", text: message }],
    isError: true,
  });
}

function parseHeaders(headerText) {
  const headers = {};
  for (const line of headerText.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }
  return headers;
}

function processIncomingBuffer() {
  while (true) {
    const headerEnd = readBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const headerText = readBuffer.slice(0, headerEnd).toString("utf8");
    const headers = parseHeaders(headerText);
    const contentLength = Number(headers["content-length"] || "0");

    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      readBuffer = readBuffer.slice(headerEnd + 4);
      continue;
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (readBuffer.length < bodyEnd) {
      return;
    }

    const bodyText = readBuffer.slice(bodyStart, bodyEnd).toString("utf8");
    readBuffer = readBuffer.slice(bodyEnd);

    const message = safeJsonParse(bodyText);
    if (!message) {
      continue;
    }

    // Fire and forget: each request sends exactly one response.
    void handleMessage(message);
  }
}

function readJsonMaybe(input) {
  const parsed = safeJsonParse((input || "").trim());
  return parsed ?? null;
}

async function runGh(args) {
  const { stdout, stderr } = await execFileAsync("gh", args, {
    maxBuffer: 1024 * 1024 * 10,
    env: process.env,
  });
  return {
    stdout,
    stderr,
  };
}

function getTargetRepo(args) {
  const owner = typeof args?.owner === "string" && args.owner.trim() ? args.owner.trim() : OWNER;
  const repo = typeof args?.repo === "string" && args.repo.trim() ? args.repo.trim() : REPO;

  if (!owner || !repo) {
    throw new Error("Missing repository context. Set GITHUB_OWNER and GITHUB_REPO, or pass owner/repo tool arguments.");
  }

  return { owner, repo };
}

async function ensureGhAuth() {
  try {
    await runGh(["auth", "status"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub CLI is not authenticated. Run 'gh auth login'. Detail: ${detail}`);
  }
}

function assertPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt must be a non-empty string");
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt exceeds max length ${MAX_PROMPT_LENGTH}`);
  }
}

function parseRunList(output, maxItems) {
  const parsed = readJsonMaybe(output);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.slice(0, maxItems).map((run) => ({
    id: run.databaseId ?? run.id ?? null,
    displayTitle: run.displayTitle ?? "",
    status: run.status ?? "",
    conclusion: run.conclusion ?? "",
    event: run.event ?? "",
    createdAt: run.createdAt ?? "",
    updatedAt: run.updatedAt ?? "",
    url: run.url ?? "",
    workflowName: run.workflowName ?? "",
    headBranch: run.headBranch ?? "",
  }));
}

function formatJson(data) {
  return JSON.stringify(data, null, 2);
}

const TOOL_DEFINITIONS = [
  {
    name: "opencode_dispatch",
    description:
      "Dispatch the opencode GitHub Actions workflow with a prompt and optional model, then return the newest matching run.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Prompt sent to opencode workflow input 'prompt'.",
        },
        model: {
          type: "string",
          description: "Optional model sent to workflow input 'model'.",
        },
        owner: {
          type: "string",
          description: "GitHub repo owner override. Defaults to GITHUB_OWNER env.",
        },
        repo: {
          type: "string",
          description: "GitHub repo name override. Defaults to GITHUB_REPO env.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "opencode_list_runs",
    description: "List recent runs of the opencode workflow.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of runs to return. Default 5.",
        },
        owner: {
          type: "string",
          description: "GitHub repo owner override. Defaults to GITHUB_OWNER env.",
        },
        repo: {
          type: "string",
          description: "GitHub repo name override. Defaults to GITHUB_REPO env.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "opencode_get_run",
    description: "Get details and logs for a specific run id.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "integer",
          description: "GitHub Actions run database id.",
        },
        owner: {
          type: "string",
          description: "GitHub repo owner override. Defaults to GITHUB_OWNER env.",
        },
        repo: {
          type: "string",
          description: "GitHub repo name override. Defaults to GITHUB_REPO env.",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
];

async function dispatchWorkflow(args) {
  assertPrompt(args.prompt);
  const { owner, repo } = getTargetRepo(args);
  await ensureGhAuth();

  const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : DEFAULT_MODEL;

  const dispatchArgs = [
    "workflow",
    "run",
    WORKFLOW_ID,
    "--repo",
    `${owner}/${repo}`,
    "-f",
    `prompt=${args.prompt}`,
    "-f",
    `model=${model}`,
  ];

  await runGh(dispatchArgs);

  const listArgs = [
    "run",
    "list",
    "--repo",
    `${owner}/${repo}`,
    "--workflow",
    WORKFLOW_ID,
    "--limit",
    "5",
    "--json",
    "databaseId,displayTitle,status,conclusion,event,createdAt,updatedAt,url,workflowName,headBranch",
  ];

  const { stdout } = await runGh(listArgs);
  const runs = parseRunList(stdout, 5);

  return {
    workflow: WORKFLOW_ID,
    repo: `${owner}/${repo}`,
    dispatched: true,
    suggestedRun: runs[0] || null,
    recentRuns: runs,
  };
}

async function listRuns(args) {
  const { owner, repo } = getTargetRepo(args);
  await ensureGhAuth();

  const limit = Number.isInteger(args.limit) ? args.limit : 5;
  const safeLimit = Math.max(1, Math.min(20, limit));

  const { stdout } = await runGh([
    "run",
    "list",
    "--repo",
    `${owner}/${repo}`,
    "--workflow",
    WORKFLOW_ID,
    "--limit",
    String(safeLimit),
    "--json",
    "databaseId,displayTitle,status,conclusion,event,createdAt,updatedAt,url,workflowName,headBranch",
  ]);

  return {
    workflow: WORKFLOW_ID,
    repo: `${owner}/${repo}`,
    runs: parseRunList(stdout, safeLimit),
  };
}

async function getRun(args) {
  const { owner, repo } = getTargetRepo(args);
  await ensureGhAuth();

  if (!Number.isInteger(args.runId) || args.runId <= 0) {
    throw new Error("runId must be a positive integer");
  }

  const runId = String(args.runId);
  const { stdout: infoStdout } = await runGh([
    "run",
    "view",
    runId,
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "databaseId,displayTitle,status,conclusion,event,createdAt,updatedAt,url,workflowName,headBranch,jobs",
  ]);

  let logsText = "";
  try {
    const { stdout: logsStdout } = await runGh([
      "run",
      "view",
      runId,
      "--repo",
      `${owner}/${repo}`,
      "--log",
    ]);
    logsText = logsStdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logsText = `Unable to fetch run logs: ${detail}`;
  }

  return {
    workflow: WORKFLOW_ID,
    repo: `${owner}/${repo}`,
    run: readJsonMaybe(infoStdout),
    logs: logsText.slice(0, 120000),
  };
}

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};

  if (name === "opencode_dispatch") {
    const result = await dispatchWorkflow(args);
    sendResult(id, {
      content: [{ type: "text", text: formatJson(result) }],
    });
    return;
  }

  if (name === "opencode_list_runs") {
    const result = await listRuns(args);
    sendResult(id, {
      content: [{ type: "text", text: formatJson(result) }],
    });
    return;
  }

  if (name === "opencode_get_run") {
    const result = await getRun(args);
    sendResult(id, {
      content: [{ type: "text", text: formatJson(result) }],
    });
    return;
  }

  sendToolError(id, `Unknown tool: ${name}`);
}

async function handleMessage(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    sendResult(id, {
      tools: TOOL_DEFINITIONS,
    });
    return;
  }

  if (method === "tools/call") {
    try {
      await handleToolCall(id, params || {});
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      sendToolError(id, detail);
    }
    return;
  }

  if (id !== undefined && id !== null) {
    sendError(id, -32601, `Method not found: ${String(method)}`);
  }
}

process.stdin.on("data", (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk]);
  processIncomingBuffer();
});

process.stdin.on("error", (error) => {
  const text = error instanceof Error ? error.message : String(error);
  console.error(text);
});
