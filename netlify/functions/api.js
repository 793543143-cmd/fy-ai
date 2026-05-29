import { handleNodeRequest } from "../../server.js";

function createRequest(event) {
  const bodyBuffer = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
    : null;
  const rawPath = event.rawUrl
    ? `${new URL(event.rawUrl).pathname}${new URL(event.rawUrl).search || ""}`
    : event.path || "/";
  const normalizedPath = rawPath.replace(/^\/\.netlify\/functions\/api/, "") || "/";

  return {
    method: event.httpMethod || "GET",
    url: normalizedPath,
    headers: event.headers || {},
    socket: { remoteAddress: event.headers?.["x-forwarded-for"] || "" },
    async *[Symbol.asyncIterator]() {
      if (bodyBuffer) yield bodyBuffer;
    }
  };
}

function createResponse() {
  let statusCode = 200;
  let headers = {};
  let body = Buffer.alloc(0);

  return {
    writeHead(nextStatus, nextHeaders = {}) {
      statusCode = nextStatus;
      headers = { ...headers, ...nextHeaders };
    },
    end(chunk = "") {
      if (Buffer.isBuffer(chunk)) body = chunk;
      else if (chunk instanceof Uint8Array) body = Buffer.from(chunk);
      else body = Buffer.from(String(chunk), "utf8");
    },
    toLambdaResponse() {
      const contentType = String(headers["Content-Type"] || headers["content-type"] || "");
      const isTextLike = /(json|text|javascript|css|html|xml|svg)/i.test(contentType);
      return {
        statusCode,
        headers,
        body: isTextLike ? body.toString("utf8") : body.toString("base64"),
        isBase64Encoded: !isTextLike
      };
    }
  };
}

export async function handler(event) {
  const req = createRequest(event);
  const res = createResponse();
  await handleNodeRequest(req, res, event.rawUrl);
  return res.toLambdaResponse();
}
