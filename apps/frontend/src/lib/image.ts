// Downscale a photo on the device before upload. A phone camera's 12 MP
// frame is a 4 MB file that reads perfectly well at 1600 px; sending the
// smaller JPEG is faster on a poor signal and keeps the server's decode
// cheap. A canvas export carries no EXIF, so nothing the camera embedded (a
// GPS fix, most of all) leaves the phone — the server strips again
// regardless. Shared by vaccine documents and milestone photos.

export const PHOTO_MAX_EDGE = 1600;

export async function downscaleImage(
  file: File,
  maxEdge = PHOTO_MAX_EDGE,
): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_000_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
    if (!blob) return file;
    const renamed = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${renamed}.jpg`, { type: "image/jpeg" });
  } catch {
    // HEIC that the browser can't decode, canvas unavailable, … — send the
    // original and let the server's allowlist and size cap decide.
    return file;
  }
}
