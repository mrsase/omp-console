import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createSession } from "./helpers";

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id}: ${violation.help}`);
}

test("the main screen has no serious accessibility violations", async ({ page }) => {
  await createSession(page);
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);
});

test("the main screen has no serious violations in the dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await createSession(page);
  const serious = await seriousViolations(page);
  expect(serious, serious.join("\n")).toEqual([]);
});
