const { redact } = require("./redact");

const MAX_DESCRIPTION_CHARS = 800;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EAI_AGAIN",
  "EPIPE",
  "ERR_NETWORK"
]);

// Error without references to the HTTP request: axios errors carry the Authorization
// header and the whole dialog in `config`, which any logger would print.
class ApiError extends Error {
  constructor(message, { status, code, details, retryAfterMs } = {}) {
    super(message);
    this.name = "ApiError";

    if (status !== undefined) {
      this.status = status;
    }

    if (code !== undefined) {
      this.code = code;
    }

    if (details !== undefined) {
      this.details = details;
    }

    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

function clip(text, maxLength = MAX_DESCRIPTION_CHARS) {
  const value = String(text);
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function getErrorDetails(error) {
  const data = error.response?.data;

  if (Buffer.isBuffer(data)) {
    const text = data.toString("utf8");

    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 1000);
    }
  }

  return data || error.message;
}

function getResponseBodyText(error) {
  const data = error?.response?.data ?? error?.details;

  if (data == null) {
    return "";
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (typeof data === "string") {
    return data;
  }

  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
}

function describeError(error) {
  if (error == null) {
    return "unknown error";
  }

  if (typeof error !== "object") {
    return redact(clip(error));
  }

  const head = [
    error.name && error.name !== "Error" ? error.name : "",
    error.code
  ].filter(Boolean).join(" ");
  const message = typeof error.message === "string" ? error.message : "";
  const status = error.status ?? error.response?.status;
  const method = typeof error.config?.method === "string" ? error.config.method.toUpperCase() : "";
  const url = typeof error.config?.url === "string" ? error.config.url : "";
  const meta = [
    status ? `status=${status}` : "",
    method && url ? `${method} ${url}` : ""
  ].filter(Boolean).join(" ");

  return redact(clip([
    head ? `${head}:` : "",
    message,
    meta ? `[${meta}]` : "",
    getResponseBodyText(error)
  ].filter(Boolean).join(" ")));
}

function toSafeError(error) {
  if (error instanceof ApiError) {
    return error;
  }

  return new ApiError(describeError(error), {
    status: error?.response?.status ?? error?.status,
    code: error?.code
  });
}

function isTransientError(error) {
  const status = error?.response?.status ?? error?.status;
  return TRANSIENT_STATUSES.has(status) || TRANSIENT_CODES.has(error?.code);
}

module.exports = {
  ApiError,
  clip,
  describeError,
  getErrorDetails,
  isTransientError,
  toSafeError
};
