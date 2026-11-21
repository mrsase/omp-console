import { expect, test } from "@playwright/test";
import { createSession, expectTranscript, composer, sendPrompt } from "./helpers";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("an image is compressed, attached and sent with the prompt", async ({ page }) => {
  await createSession(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "console-shot.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  const preview = page.locator(".attachment img").first();
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview).toHaveAttribute("src", /^data:image\/jpeg;base64,/);

  await sendPrompt(page, "This is the attached screenshot.");
  await expectTranscript(page, "This is the attached screenshot.");
  await expect(page.locator(".prompt-image").first()).toBeVisible({ timeout: 20_000 });
  const box = await composer(page);
  await expect(box).toHaveValue("");
});
