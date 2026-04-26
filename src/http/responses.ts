/**
 * Tiny response helpers. Wrap `http.ServerResponse` writes so handlers
 * stay declarative (`return jsonResponse(res, 200, body)`) and we have
 * one place to enforce the §1 contract: UTF-8, JSON content-type,
 * `Cache-Control: no-store` (snapshot endpoints reflect live state).
 */
import type { ServerResponse } from 'http';

/** Snapshot Content-Type per SSE-PROTOCOL.md §1. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Write a JSON response. Always serializes via `JSON.stringify`; consumers
 * that need a custom replacer should encode upstream and use
 * {@link rawJsonResponse}.
 */
export function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Write a pre-serialized JSON string (caller has already stringified).
 * Used by tests that want to verify byte-exact output.
 */
export function rawJsonResponse(
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

/** SSE-PROTOCOL.md §9 — error response shape. */
export interface HttpErrorBody {
  error: string;
  /** Optional context, e.g. `{ ensemble: 'foo' }`. */
  [key: string]: unknown;
}

export function errorResponse(
  res: ServerResponse,
  status: number,
  body: HttpErrorBody,
  extraHeaders: Record<string, string> = {},
): void {
  jsonResponse(res, status, body, extraHeaders);
}
