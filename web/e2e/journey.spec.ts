import { expect, test } from "@playwright/test";
import {
  answer,
  approve,
  composer,
  createSession,
  expectTranscript,
  sendPrompt,
} from "./helpers";

test("create → stream → tool row → approval → ask field → done", async ({ page }) => {
  await createSession(page);

  await sendPrompt(page, "Run the stub journey.");
  await expectTranscript(page, "I'll run the command and ask the question.");
  await expectTranscript(page, /echo omp-console-fixture/);

  await approve(page);
  await answer(page, ["Blue"]);

  await expectTranscript(page, "DONE");

  const transcript = page.getByTestId("transcript");
  await transcript.getByRole("button", { name: /ask question/i }).click();
  await expectTranscript(page, /User answers/);
  await expectTranscript(page, /"color": "Blue"/);
  await expect(page.getByText(/quota exhausted/i)).toHaveCount(0);

  const box = await composer(page);
  await expect(box).toBeVisible();
});
