import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { ApiError } from "./types.js";
import type { MediaService } from "./service.js";

type Route = "begin" | "renew" | "complete" | "gallery" | "usage";
export interface Dependencies {
  authenticate(authorization: string | null): Promise<string>;
  service(): Promise<MediaService>;
}

async function jsonBody(request: HttpRequest): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new ApiError(400, "Content-Type must be application/json");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 16 * 1024)) {
    throw new ApiError(413, "Request body too large");
  }
  let size = 0;
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Invalid JSON body");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024) {
        await reader.cancel();
        throw new ApiError(413, "Request body too large");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Invalid JSON body");
  } finally {
    reader.releaseLock();
  }
}

export function createHandler(route: Route, dependencies: () => Dependencies) {
  return async (request: HttpRequest): Promise<HttpResponseInit> => {
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    try {
      const deps = dependencies();
      const owner = await deps.authenticate(request.headers.get("authorization"));
      // Authentication precedes body parsing, cursor handling, and all storage access.
      const body = route === "begin" || route === "complete" ? await jsonBody(request) : undefined;
      if (route === "complete" && (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).length !== 0)) throw new ApiError(400, "Completion body must be an empty object");
      const service = await deps.service();
      let result: unknown;
      switch (route) {
        case "begin": result = await service.begin(owner, body); break;
        case "renew": result = await service.renew(owner, request.params.uploadId ?? ""); break;
        case "complete": result = await service.complete(owner, request.params.uploadId ?? ""); break;
        case "gallery": result = await service.gallery(owner, request.query.get("cursor") ?? undefined); break;
        case "usage": result = await service.usage(); break;
      }
      return { status: 200, headers, jsonBody: result };
    } catch (error) {
      return {
        status: error instanceof ApiError ? error.status : 500,
        headers,
        jsonBody: { error: error instanceof ApiError ? error.message : "Internal server error" },
      };
    }
  };
}
