import { expect, test } from "@playwright/test";
import {
  answer,
  approve,
  composer,
  composerText,
  createSession,
  expectTranscript,
  firstVisible,
  sendPrompt,
  sendWhileRunning,
} from "./helpers";

test("steer while a turn is running lands on the next turn", async ({ page }) => {
  await createSession(page);
  await sendPrompt(page, "Run the stub journey.");
  await expectTranscript(page, "I'll run the command and ask the question.");

  await sendWhileRunning(page, "Also check the log.", "steer");
  await approve(page);
  await answer(page, ["Red"]);

  await expectTranscript(page, /Acknowledged the steer: Also check the log\./);
  await expectTranscript(page, "DONE");
});

test("stop with a queued follow-up restores the composer", async ({ page }) => {
  const sent: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => {
      try {
        const message = JSON.parse(String(event.payload)) as { op?: string; frame?: { type?: string } };
        if (message.op === "command" && message.frame?.type) sent.push(message.frame.type);
      } catch {
        // ignore non-JSON frames
      }
    });
  });

  await createSession(page);
  await sendPrompt(page, "Run the stub journey.");
  await expectTranscript(page, "I'll run the command and ask the question.");

  await sendWhileRunning(page, "Queued follow-up", "queue");
  await firstVisible([() => page.getByText(/Queued follow-up/i)]);

  const stop = await firstVisible(
    [
      () => page.getByRole("button", { name: /^stop$/i }),
      () => page.getByRole("button", { name: /stop/i }),
    ],
    5_000,
  );
  await stop.click();
  expect(sent, `frames sent: ${sent.join(", ")}`).toContain("follow_up");
  expect(sent, `frames sent: ${sent.join(", ")}`).toContain("abort_and_restore_queue");

  const box = await composer(page);
  await expect
    .poll(() => composerText(box), { timeout: 20_000 })
    .toContain("Queued follow-up");
});
