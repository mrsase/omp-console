export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 150 * 1024;
export const COMMAND_BUDGET = 900 * 1024;
export const MAX_IMAGE_DIMENSION = 1600;

export interface Attachment {
  name: string;
  mimeType: string;
  data: string;
  width: number;
  height: number;
  bytes: number;
}

export interface ImageCompressor {
  (file: File): Promise<Attachment>;
}

function dataUrlBase64(url: string): string {
  const index = url.indexOf(",");
  return index >= 0 ? url.slice(index + 1) : "";
}

async function loadBitmap(file: File): Promise<{ width: number; height: number; draw: CanvasImageSource }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, draw: bitmap };
  }
  const url = URL.createObjectURL(file);
  try {
    const { promise, resolve, reject } = Promise.withResolvers<HTMLImageElement>();
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("image decode failed"));
    element.src = url;
    const image = await promise;
    return { width: image.naturalWidth, height: image.naturalHeight, draw: image };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Canvas compression: scale to <=1600 px and step JPEG quality to <=150 KiB. */
export const compressImage: ImageCompressor = async (file) => {
  const source = await loadBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(source.width, source.height));
  let width = Math.max(1, Math.round(source.width * scale));
  let height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    context.drawImage(source.draw, 0, 0, width, height);
    for (let quality = 0.85; quality >= 0.4; quality -= 0.1) {
      const url = canvas.toDataURL("image/jpeg", quality);
      const data = dataUrlBase64(url);
      const bytes = Math.floor((data.length * 3) / 4);
      if (bytes <= MAX_IMAGE_BYTES) {
        return { name: file.name, mimeType: "image/jpeg", data, width, height, bytes };
      }
    }
    width = Math.max(1, Math.round(width * 0.8));
    height = Math.max(1, Math.round(height * 0.8));
  }
  throw new Error("could not compress image under 150 KiB");
};

export interface PrepareResult {
  attachments: Attachment[];
  errors: string[];
}

export async function prepareAttachments(
  files: File[],
  existing: number,
  compress: ImageCompressor = compressImage,
): Promise<PrepareResult> {
  const errors: string[] = [];
  const room = Math.max(0, MAX_IMAGES - existing);
  const accepted = files.filter((file) => file.type.startsWith("image/"));
  if (accepted.length < files.length) errors.push("Only images can be attached.");
  if (accepted.length > room) errors.push(`At most ${MAX_IMAGES} images per message.`);
  const attachments: Attachment[] = [];
  for (const file of accepted.slice(0, room)) {
    try {
      const attachment = await compress(file);
      if (attachment.bytes > MAX_IMAGE_BYTES) {
        errors.push(`${file.name} is larger than 150 KiB after compression.`);
        continue;
      }
      attachments.push(attachment);
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : "compression failed"}`);
    }
  }
  if (commandSize(attachments) > COMMAND_BUDGET) {
    errors.push("Attachments exceed the 900 KiB command budget. Remove one and try again.");
    return { attachments: [], errors };
  }
  return { attachments, errors };
}

/** Base64 payload length is a safe upper bound proxy for the JSON command size. */
export function commandSize(attachments: Attachment[]): number {
  return attachments.reduce((total, item) => total + item.data.length + item.mimeType.length + 64, 0);
}

export function overBudget(attachments: Attachment[]): boolean {
  return commandSize(attachments) > COMMAND_BUDGET;
}

export function toWireImages(attachments: Attachment[]): { type: "image"; mimeType: string; data: string }[] {
  return attachments.map((attachment) => ({ type: "image", mimeType: attachment.mimeType, data: attachment.data }));
}
