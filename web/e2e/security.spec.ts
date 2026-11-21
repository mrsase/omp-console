import { expect, test } from "@playwright/test";
import { request as httpRequest } from "node:http";
import { BASE } from "./helpers";

function status(path: string, headers: Record<string, string>): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const request = httpRequest(
    { host: "127.0.0.1", port: 8789, path, method: "GET", headers },
    (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    },
  );
  request.on("error", reject);
  request.end();
  return promise;
}

test("a non-loopback Host is rejected with 421", async () => {
  expect(await status("/api/info", { Host: "evil.example" })).toBe(421);
});

test("a cross-site request is rejected with 403", async () => {
  const statusCode = await status("/api/info", {
    Host: "127.0.0.1:8789",
    Origin: "http://evil.example",
    "Sec-Fetch-Site": "cross-site",
  });
  expect(statusCode).toBe(403);
  expect(await status("/api/info", { Host: "127.0.0.1:8789" })).toBe(200);
});

test("the documented base URL answers health", async ({ request }) => {
  const response = await request.get(`${BASE}/healthz`);
  expect(response.ok()).toBeTruthy();
  expect((await response.text()).trim()).toContain("ok");
});
