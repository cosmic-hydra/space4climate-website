import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 4141);
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || "";
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY || "";
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || "";
const FORCE_MODEL = (process.env.FORCE_MODEL || "true").toLowerCase() === "true";

if (!OPENCODE_BASE_URL) {
  console.error("Missing OPENCODE_BASE_URL");
  process.exit(1);
}

if (!OPENCODE_API_KEY) {
  console.error("Missing OPENCODE_API_KEY");
  process.exit(1);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function upstreamUrl(pathname, search = "") {
  const base = OPENCODE_BASE_URL.endsWith("/")
    ? OPENCODE_BASE_URL.slice(0, -1)
    : OPENCODE_BASE_URL;
  return `${base}${pathname}${search}`;
}

function normalizePath(pathname) {
  if (pathname === "/inference/chat/completions") {
    return "/v1/chat/completions";
  }
  if (pathname === "/inference/models") {
    return "/v1/models";
  }
  return pathname;
}

function copyRequestHeaders(req) {
  const headers = {
    "content-type": req.headers["content-type"] || "application/json",
    accept: req.headers.accept || "application/json",
    authorization: `Bearer ${OPENCODE_API_KEY}`,
  };

  if (req.headers["accept-encoding"]) {
    headers["accept-encoding"] = req.headers["accept-encoding"];
  }

  return headers;
}

async function proxyRequest(req, res) {
  try {
    const incomingUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    const method = req.method || "GET";

    if (incomingUrl.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!incomingUrl.pathname.startsWith("/v1/") && !incomingUrl.pathname.startsWith("/inference/")) {
      sendJson(res, 404, {
        error: "Use /v1/* or /inference/* endpoints",
      });
      return;
    }

    const targetPath = normalizePath(incomingUrl.pathname);
    let bodyText = method === "GET" || method === "HEAD" ? "" : await readBody(req);

    if (bodyText && targetPath === "/v1/chat/completions") {
      const parsed = JSON.parse(bodyText);
      if (OPENCODE_MODEL && FORCE_MODEL) {
        parsed.model = OPENCODE_MODEL;
      } else if (!parsed.model && OPENCODE_MODEL) {
        parsed.model = OPENCODE_MODEL;
      }
      bodyText = JSON.stringify(parsed);
    }

    const headers = copyRequestHeaders(req);
    if (bodyText) {
      headers["content-length"] = Buffer.byteLength(bodyText).toString();
    }

    const response = await fetch(upstreamUrl(targetPath, incomingUrl.search), {
      method,
      headers,
      body: bodyText || undefined,
      redirect: "manual",
    });

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "content-encoding") {
        responseHeaders[key] = value;
      }
    });

    res.writeHead(response.status, responseHeaders);

    if (!response.body) {
      res.end();
      return;
    }

    for await (const chunk of response.body) {
      res.write(chunk);
    }

    res.end();
  } catch (error) {
    sendJson(res, 502, {
      error: "Proxy failure",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

const server = http.createServer(proxyRequest);

server.listen(PORT, () => {
  console.log(`opencode proxy listening on http://127.0.0.1:${PORT}`);
});
