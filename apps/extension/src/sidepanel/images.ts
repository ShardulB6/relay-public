import type { Api, ImageContent, Model, ModelImageResizeOptions } from "@earendil-works/pi-ai";

/** Formats every supported provider accepts; anything else is refused at the composer. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Used when the model declares no resize profile. Within every provider's documented limits. */
const DEFAULT_RESIZE: Required<ModelImageResizeOptions> = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 5 * 1024 * 1024,
  jpegQuality: 0.85,
};

async function toBase64(blob: Blob): Promise<string> {
  return new Uint8Array(await blob.arrayBuffer()).toBase64();
}

/** Base64 inflates by 4/3; the limit applies to what is sent, not the file. */
function base64Size(blob: Blob): number {
  return Math.ceil(blob.size / 3) * 4;
}

/**
 * Turn a pasted or dropped file into an image block for the model, downscaled and re-encoded
 * when it exceeds the model's limits. Files that already fit are sent byte for byte.
 */
export async function prepareImage(
  file: Blob,
  model: Model<Api> | undefined,
): Promise<ImageContent> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error(
      `Unsupported image type: ${file.type || "unknown"}. Use PNG, JPEG, GIF or WebP.`,
    );
  }
  const limits = { ...DEFAULT_RESIZE, ...model?.inputLimits?.images?.resize };
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, limits.maxWidth / bitmap.width, limits.maxHeight / bitmap.height);
    if (scale === 1 && base64Size(file) <= limits.maxBytes) {
      return { type: "image", data: await toBase64(file), mimeType: file.type };
    }
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Re-encoding drops GIF animation; PNG keeps screenshots crisp, JPEG keeps photos small.
    let blob = await canvas.convertToBlob({
      type: file.type === "image/png" ? "image/png" : "image/jpeg",
      quality: limits.jpegQuality,
    });
    if (base64Size(blob) > limits.maxBytes) {
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: limits.jpegQuality });
    }
    if (base64Size(blob) > limits.maxBytes) {
      throw new Error(
        `The image is too large to send (over ${Math.round(limits.maxBytes / 1024 / 1024)} MB after resizing).`,
      );
    }
    return { type: "image", data: await toBase64(blob), mimeType: blob.type };
  } finally {
    bitmap.close();
  }
}

/** Image files from a paste or drop, in the order they were given. */
export function imageFiles(transfer: DataTransfer | null): File[] {
  return [...(transfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
}
