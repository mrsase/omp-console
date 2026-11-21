import { expect, test } from "@playwright/test";
import {
  answer,
  approve,
  closeThread,
  composer,
  createSession,
  expectTranscript,
  firstVisible,
  sendPrompt,
} from "./helpers";

test("closed session resumes from Saved with its transcript", async ({ page }) => {
  const cwd = await createSession(page);
  await sendPrompt(page, "Run the stub journey.");
  await expectTranscript(page, "I'll run the command and ask the question.");
  await approve(page);
  await answer(page, ["Red"]);
  await expectTranscript(page, "DONE");

  await closeThread(page, cwd);

  await page.reload();
  await firstVisible(
    [
      () => page.getByRole("button", { name: /new session/i }),
      () => page.getByText(/new session/i),
    ],
    25_000,
  );

  const saved = await firstVisible(
    [
      () => page.locator(`[data-saved="true"][title="${cwd}"]`),
      () => page.locator('[data-saved="true"]', { hasText: "Stub session" }),
    ],
    20_000,
  );
  await saved.click();

  await composer(page);
  await expectTranscript(page, "Run the stub journey.");
  await expectTranscript(page, "DONE");
});
