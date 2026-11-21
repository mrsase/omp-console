import { expect, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const BASE = "http://127.0.0.1:8789";

/**
 * Locators differ while the UI is still being written; try the stable
 * data attributes first and fall back to accessible names. Copy may change,
 * observable state may not.
 */
export async function firstVisible(
  candidates: Array<() => Locator>,
  timeout = 10_000,
): Promise<Locator> {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    for (const make of candidates) {
      try {
        const locator = make().first();
        if ((await locator.count()) > 0 && (await locator.isVisible())) return locator;
      } catch (error) {
        last = String(error);
      }
    }
    await delay(100);
  }
  throw new Error(`no candidate became visible${last ? ` (${last})` : ""}`);
}

export async function composer(page: Page): Promise<Locator> {
  return firstVisible(
    [
      () => page.getByTestId("composer-input"),
      () => page.getByRole("textbox", { name: /^message$/i }),
      () => page.locator("textarea"),
    ],
    25_000,
  );
}

export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await firstVisible(
    [
      () => page.getByRole("button", { name: /new session/i }),
      () => page.getByText(/new session/i),
    ],
    25_000,
  );
}

/**
 * Create a session through the dialog's folder browser in a unique folder under
 * the server's session root. Returns the thread's canonical cwd.
 */
export async function createSession(page: Page): Promise<string> {
  // A previous test's open thread would be auto-selected on load, changing the
  // dialog's default folder and replaying pending dialogs. Start clean.
  for (let pass = 0; pass < 4; pass += 1) {
    const listed = await page.request.get(`${BASE}/api/threads`);
    if (!listed.ok()) break;
    const threads = (await listed.json()) as Array<{ id: string }>;
    if (threads.length === 0) break;
    for (const thread of threads) await page.request.delete(`${BASE}/api/threads/${thread.id}`);
    await delay(150);
  }
  await openApp(page);
  const info = (await (await page.request.get(`${BASE}/api/info`)).json()) as { sessionRoot: string };
  const sessionRoot = realpathSync(info.sessionRoot);

  const button = await firstVisible([
    () => page.getByRole("button", { name: /new session/i }),
    () => page.getByText(/new session/i),
  ]);
  await button.click();

  const sheet = page.getByRole("dialog").last();
  await expect(sheet).toBeVisible();
  const shownPath = sheet.locator(".folder-path code");
  await expect(shownPath).toHaveText(/\S/, { timeout: 15_000 });
  let shown = realpathSync((await shownPath.innerText()).trim());
  for (let up = 0; up < 4 && shown !== sessionRoot; up += 1) {
    const parent = sheet.getByRole("button", { name: /parent folder/i });
    if (!(await parent.isEnabled())) break;
    await parent.click();
    await delay(150);
    const next = realpathSync((await shownPath.innerText()).trim());
    if (next === shown) break;
    shown = next;
  }
  if (shown !== sessionRoot) throw new Error(`new-session dialog is stuck at ${shown}, not ${sessionRoot}`);

  let folder = shown;
  if (shown === sessionRoot) {
    folder = realpathSync(mkdtempSync(join(sessionRoot, "case-")));
    await sheet.getByRole("button", { name: /^go$/i }).click();
    const row = await firstVisible(
      [() => sheet.getByRole("button", { name: new RegExp(`^${basename(folder)}$`) })],
      15_000,
    );
    await row.click();
    await expect(shownPath).toContainText(basename(folder));
  }

  await sheet.getByRole("button", { name: /^start session$/i }).click();
  await expect(sheet).toBeHidden({ timeout: 20_000 });
  const box = await composer(page);
  await expect(box).toHaveAttribute("placeholder", /Message omp/i, { timeout: 25_000 });

  const threads = (await (await page.request.get(`${BASE}/api/threads`)).json()) as Array<{
    id: string;
    cwd: string;
  }>;
  const threadCwd = threads.find((thread) => thread.cwd === folder)?.cwd ?? folder;
  const name = basename(threadCwd);

  // A late lifecycle frame can leave the store on threads[0]; make the thread
  // this test created the selected one before any prompt or dialog work.
  const row = page.locator('[data-testid="rail"] button.rail-row-main', { hasText: name }).first();
  if ((await row.count()) > 0) await row.click();
  await expect(page.getByTestId("header")).toContainText(name, { timeout: 20_000 });
  await expect(await composer(page)).toHaveAttribute("placeholder", /Message omp/i, {
    timeout: 25_000,
  });
  return threadCwd;
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const box = await composer(page);
  await box.fill(text);
  await box.press("Enter");
}

/** Answer dialog options in order (rich ask uses Submit last). */
export async function answer(page: Page, choices: string[]): Promise<void> {
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toBeVisible({ timeout: 25_000 });
  for (const choice of choices) {
    const pattern = new RegExp(`^(\\d+\\s*)?${choice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    await firstVisible(
      [
        () => dialog.getByRole("option", { name: pattern }),
        () => dialog.getByRole("button", { name: pattern }),
        () => dialog.getByText(pattern),
      ],
      10_000,
    ).then((target) => target.click());
    await delay(80);
  }
}

export async function approve(page: Page): Promise<void> {
  await answer(page, ["Approve"]);
}

export async function expectTranscript(page: Page, text: string | RegExp): Promise<void> {
  const region = page.getByTestId("transcript");
  const scope = (await region.count()) > 0 ? region.first() : page.locator("body");
  // Rows only: the outline is a <select> whose hidden <option> text would
  // otherwise satisfy getByText and hide a missing transcript row.
  await expect(scope.locator("[data-message-key]").getByText(text).first()).toBeVisible({
    timeout: 30_000,
  });
}

export async function sendWhileRunning(page: Page, text: string, mode: "steer" | "queue"): Promise<void> {
  const box = await composer(page);
  await box.fill(text);
  const modeName = mode === "queue" ? /queue next/i : /steer now/i;
  const chosen = await firstVisible([() => page.getByRole("button", { name: modeName })], 3_000).catch(
    () => null,
  );
  if (chosen) await chosen.click();
  const send = await firstVisible(
    [
      () => page.locator("button.send-button"),
      () => page.getByRole("button", { name: mode === "queue" ? /^queue/i : /^steer/i }),
    ],
    5_000,
  ).catch(() => null);
  if (send) await send.click();
  else await box.press("Enter");
}

export async function composerText(box: Locator): Promise<string> {
  return box.evaluate((element) => {
    if ("value" in element && typeof (element as HTMLTextAreaElement).value === "string") {
      return (element as HTMLTextAreaElement).value;
    }
    return element.textContent ?? "";
  });
}

/** Close the session under test through the API, leaving its file for Saved. */
export async function closeThread(page: Page, cwd: string): Promise<string> {
  const listed = await page.request.get(`${BASE}/api/threads`);
  expect(listed.ok()).toBeTruthy();
  const threads = (await listed.json()) as Array<{ id: string; cwd: string }>;
  const thread = threads.find((entry) => entry.cwd === cwd);
  expect(thread, `a thread for ${cwd}`).toBeTruthy();
  const removed = await page.request.delete(`${BASE}/api/threads/${thread!.id}`);
  expect(removed.ok()).toBeTruthy();
  return thread!.id;
}
