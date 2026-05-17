import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 4141);
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || "";
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY || "";
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || "";
const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY || "";
const FORCE_MODEL = (process.env.FORCE_MODEL || "true").toLowerCase() === "true";
const ENABLE_CORS = (process.env.ENABLE_CORS || "true").toLowerCase() === "true";
const MAX_AUDIT_ENTRIES = Number(process.env.MAX_AUDIT_ENTRIES || 100);

const audit = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  proxiedRequests: 0,
  rejectedAuth: 0,
  recent: [],
};

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
    ...(ENABLE_CORS
      ? {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        }
      : {}),
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

function clientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function recordRequest(req, pathname, outcome) {
  audit.totalRequests += 1;
  if (outcome === "proxied") {
    audit.proxiedRequests += 1;
  }
  if (outcome === "rejected-auth") {
    audit.rejectedAuth += 1;
  }

  const entry = {
    at: new Date().toISOString(),
    method: req.method || "GET",
    path: pathname,
    outcome,
    userAgent: req.headers["user-agent"] || "",
    ip: clientIp(req),
  };

  audit.recent.push(entry);
  if (audit.recent.length > MAX_AUDIT_ENTRIES) {
    audit.recent.shift();
  }
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
  if (pathname === "/inference/responses") {
    return "/v1/responses";
  }
  return pathname;
}

function bearerToken(req) {
  const value = req.headers.authorization || "";
  const [scheme, token] = value.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return "";
  }
  return token;
}

function validateProviderApiKey(req) {
  if (!PROVIDER_API_KEY) {
    return true;
  }
  return bearerToken(req) === PROVIDER_API_KEY;
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

    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...(ENABLE_CORS
          ? {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
              "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            }
          : {}),
      });
      res.end();
      return;
    }

    if (incomingUrl.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        providerAuthRequired: Boolean(PROVIDER_API_KEY),
        startedAt: audit.startedAt,
        totalRequests: audit.totalRequests,
        proxiedRequests: audit.proxiedRequests,
        rejectedAuth: audit.rejectedAuth,
      });
      return;
    }

    if (incomingUrl.pathname === "/debug/requests") {
      sendJson(res, 200, {
        startedAt: audit.startedAt,
        totalRequests: audit.totalRequests,
        proxiedRequests: audit.proxiedRequests,
        rejectedAuth: audit.rejectedAuth,
        recent: audit.recent,
      });
      return;
    }

    if (incomingUrl.pathname === "/v1/models" && method === "GET" && OPENCODE_MODEL) {
      if (!validateProviderApiKey(req)) {
        sendJson(res, 401, {
          error: {
            message: "Invalid provider API key",
            type: "invalid_request_error",
          },
        });
        return;
      }
      sendJson(res, 200, {
        object: "list",
        data: [
          {
            id: OPENCODE_MODEL,
            object: "model",
            created: 0,
            owned_by: "opencode-proxy",
          },
        ],
      });
      return;
    }

    if (!incomingUrl.pathname.startsWith("/v1/") && !incomingUrl.pathname.startsWith("/inference/")) {
      recordRequest(req, incomingUrl.pathname, "rejected-path");
      sendJson(res, 404, {
        error: "Use /v1/* or /inference/* endpoints",
      });
      return;
    }

    if (!validateProviderApiKey(req)) {
      recordRequest(req, incomingUrl.pathname, "rejected-auth");
      sendJson(res, 401, {
        error: {
          message: "Invalid provider API key",
          type: "invalid_request_error",
        },
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

    recordRequest(req, incomingUrl.pathname, "proxied");

    const responseHeaders = {
      ...(ENABLE_CORS
        ? {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          }
        : {}),
    };
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
