import { describe, expect, it } from "vitest";
import { allowedBrowserOrigin, allowedDevelopmentOrigins } from "../src/browserOrigin";

const internal = "http://excel:3000/api/ui/workbooks/report/cells";
const publicUrl = "http://localhost:45678";
function request(headers: Record<string, string> = {}) {
  return new Request(internal, { method: "PATCH", headers });
}

describe("browser origin behind the workplace proxy", () => {
  it("accepts the configured public origin despite the internal request URL", () => {
    expect(allowedBrowserOrigin(request({ origin: publicUrl, "sec-fetch-site": "same-origin" }), {
      SANDBOX_PUBLIC_URL: `${publicUrl}/`,
    })).toBe(true);
  });

  it("rejects other workplaces, null origins, and cross-site fetches", () => {
    for (const origin of ["http://localhost:45679", "http://excel:3000", "https://other.example", "null"]) {
      expect(allowedBrowserOrigin(request({ origin }), { SANDBOX_PUBLIC_URL: publicUrl })).toBe(false);
    }
    expect(allowedBrowserOrigin(request({ origin: publicUrl, "sec-fetch-site": "cross-site" }), {
      SANDBOX_PUBLIC_URL: publicUrl,
    })).toBe(false);
  });

  it("never lets forwarded host headers authorize a hostile origin", () => {
    expect(allowedBrowserOrigin(request({
      origin: "https://other.example", host: "other.example", "x-forwarded-host": "other.example",
      "x-forwarded-proto": "https",
    }), { SANDBOX_PUBLIC_URL: publicUrl })).toBe(false);
  });

  it("preserves shared-development origin and absent-origin behavior", () => {
    expect(allowedBrowserOrigin(request({ origin: "http://excel:3000" }), {})).toBe(true);
    expect(allowedBrowserOrigin(request(), {})).toBe(true);
    expect(allowedBrowserOrigin(request({ "sec-fetch-site": "cross-site" }), {})).toBe(false);
  });

  it("fails closed for malformed public URL configuration", () => {
    for (const configured of ["not a URL", "file:///tmp/workplace", "data:text/plain,hello"]) {
      expect(allowedBrowserOrigin(request(), { SANDBOX_PUBLIC_URL: configured })).toBe(false);
    }
  });

  it("allows Next assets only for the configured public hostname without wildcard grants", () => {
    expect(allowedDevelopmentOrigins({ SANDBOX_PUBLIC_URL: "http://127.0.0.1:45678" })).toEqual(["127.0.0.1"]);
    expect(allowedDevelopmentOrigins({ SANDBOX_PUBLIC_URL: "https://workplace.example:45678/" })).toEqual(["workplace.example"]);
    for (const value of [undefined, "not a URL", "file:///tmp/workplace", "https://*.example"]) {
      expect(allowedDevelopmentOrigins({ SANDBOX_PUBLIC_URL: value })).toEqual([]);
    }
  });
});
