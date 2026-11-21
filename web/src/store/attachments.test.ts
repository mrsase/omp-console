import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_BUDGET,
  compressImage,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  overBudget,
  prepareAttachments,
  toWireImages,
  type Attachment,
  type ImageCompressor,
} from "./attachments";

function file(name: string, type = "image/png", size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

function compressor(dataLength = 1000, bytes = 1000): ImageCompressor {
  return async (item) => ({
    name: item.name,
    mimeType: "image/jpeg",
    data: "a".repeat(dataLength),
    width: 1600,
    height: 1000,
    bytes,
  });
}

describe("attachment preparation", () => {
  it("caps at four images", async () => {
    const files = Array.from({ length: 6 }, (_, index) => file(`image-${index}.png`));
    const result = await prepareAttachments(files, 0, compressor());
    expect(result.attachments).toHaveLength(MAX_IMAGES);
    expect(result.errors.join(" ")).toContain("At most 4 images");
  });

  it("rejects an image larger than 150 KiB after compression", async () => {
    const result = await prepareAttachments([file("huge.png")], 0, compressor(1000, MAX_IMAGE_BYTES + 1));
    expect(result.attachments).toHaveLength(0);
    expect(result.errors.join(" ")).toContain("150 KiB");
  });

  it("enforces the 900 KiB command budget", async () => {
    const result = await prepareAttachments(
      Array.from({ length: 4 }, (_, index) => file(`${index}.png`)),
      0,
      compressor(300_000, 1000),
    );
    expect(result.attachments).toHaveLength(0);
    expect(result.errors.join(" ")).toContain("900 KiB");
  });

  it("rejects non-image files", async () => {
    const result = await prepareAttachments([file("notes.txt", "text/plain")], 0, compressor());
    expect(result.attachments).toHaveLength(0);
    expect(result.errors[0]).toContain("Only images");
  });

  it("compresses a 3000×2000 image to a JPEG under 150 KiB", async () => {
    const originalCreate = document.createElement.bind(document);
    const context = { drawImage: vi.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: () => `data:image/jpeg;base64,${"A".repeat(1000)}`,
    };
    vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      if (tag === "canvas") return canvas as unknown as HTMLElement;
      return originalCreate(tag, options);
    }) as typeof document.createElement);
    vi.stubGlobal("createImageBitmap", async () => ({ width: 3000, height: 2000 }));
    const result = await compressImage(new File([new Uint8Array(32)], "large.png", { type: "image/png" }));
    expect(result.mimeType).toBe("image/jpeg");
    expect(Math.max(result.width, result.height)).toBe(1600);
    expect(result.bytes).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(context.drawImage).toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("converts attachments to wire images and detects the budget", () => {
    const attachment: Attachment = {
      name: "a.png",
      mimeType: "image/jpeg",
      data: "abc",
      width: 1,
      height: 1,
      bytes: 3,
    };
    expect(toWireImages([attachment])).toEqual([{ type: "image", mimeType: "image/jpeg", data: "abc" }]);
    expect(overBudget([attachment])).toBe(false);
    expect(overBudget([{ ...attachment, data: "a".repeat(COMMAND_BUDGET) }])).toBe(true);
  });
});
