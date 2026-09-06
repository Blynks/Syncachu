import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ApiError } from "./types.js";

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const issuers = ["accounts.google.com", "https://accounts.google.com"];

export function createAuthenticator(clientIds: string[], allowedEmails: string[], keys: JWTVerifyGetKey = googleKeys) {
  if (!clientIds.length || clientIds.includes("*")) throw new Error("Explicit audiences required");
  const approved = new Set(allowedEmails.map(email => email.trim().toLowerCase()));
  if (!approved.size || [...approved].some(email => !/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email))) {
    throw new Error("Explicit approved Google email addresses required");
  }
  return async (authorization: string | null): Promise<string> => {
    const [scheme, token, extra] = (authorization ?? "").split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token || extra !== undefined || token.length > 8192) {
      throw new ApiError(401, "Unauthorized");
    }
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: issuers,
        audience: clientIds,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub", "iss", "aud"],
      });
      if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 255) {
        throw new Error("Invalid subject");
      }
      if (payload.azp !== undefined && (typeof payload.azp !== "string" || !clientIds.includes(payload.azp))) {
        throw new Error("Invalid authorized party");
      }
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && !payload.azp) {
        throw new Error("Missing authorized party");
      }
      if (payload.email_verified !== true || typeof payload.email !== "string"
        || !approved.has(payload.email.toLowerCase())) throw new ApiError(403, "This Google account is not approved for this private instance.");
      return createHash("sha256").update(`https://accounts.google.com:${payload.sub}`).digest("hex");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(401, "Unauthorized");
    }
  };
}
