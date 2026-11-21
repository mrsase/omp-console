import { expect, test } from "@playwright/test";
import { createSession, firstVisible } from "./helpers";

test("model and thinking changes are confirmed by get_state", async ({ page }) => {
  await createSession(page);

  const settings = await firstVisible(
    [
      () => page.getByRole("button", { name: /settings/i }),
      () => page.getByText(/^settings$/i),
    ],
    10_000,
  );
  await settings.click();

  const sheet = page.getByRole("dialog").last();
  await expect(sheet).toBeVisible();
  const model = await firstVisible([() => sheet.getByRole("radio", { name: /Claude Sonnet 5/i })], 10_000);
  await model.click();
  const thinking = await firstVisible([() => sheet.getByRole("button", { name: /^high$/i })], 5_000);
  await thinking.click();
  await sheet.getByRole("button", { name: /close settings/i }).click();
  await expect(sheet).toBeHidden();

  const header = page.getByTestId("header");
  await expect(header.getByText("Claude Sonnet 5")).toBeVisible({ timeout: 20_000 });
  await expect(header.getByText("high", { exact: true })).toBeVisible({ timeout: 20_000 });
});
