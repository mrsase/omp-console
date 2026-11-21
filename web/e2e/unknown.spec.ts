import { expect, test } from "@playwright/test";
import { createSession, expectTranscript, firstVisible } from "./helpers";

test("an unknown child frame becomes protocol evidence, never a crash", async ({ page }) => {
  await createSession(page);

  // The stub emits `{"type":"notify",...}` which is not a known frame type.
  const evidence = await firstVisible(
    [
      () => page.getByText(/unknown omp frame.*notify/i),
      () => page.getByText(/notify.*protocol evidence/i),
      () => page.getByRole("button", { name: /protocol/i }),
      () => page.getByText(/protocol/i),
    ],
    25_000,
  );
  await evidence.click().catch(() => undefined);

  await expectTranscript(page, /unknown omp frame .*notify/i);
  await expect(page.getByText(/unknown \d+/).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /new session/i })).toBeVisible();
});
