// Centre-crop to a square and resize on the device before upload (spec §4):
// the server accepts at most 512 KB / 1024 px and never sees the original.
// A canvas export carries no EXIF, so nothing the camera embedded (a GPS
// fix, most of all) leaves the phone — the server strips again regardless.
//
// Decoding goes through an <img> rather than createImageBitmap: Safari
// decodes HEIC for <img> and applies EXIF orientation there, which is the
// path an iPhone photo needs.

export const AVATAR_SIZE = 512;

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image"));
    };
    img.src = url;
  });
}

export async function prepareAvatar(
  file: Blob,
  size = AVATAR_SIZE,
): Promise<Blob> {
  const img = await loadImage(file);
  const edge = Math.min(img.naturalWidth, img.naturalHeight);
  if (edge <= 0) throw new Error("Could not read that image");
  const sx = (img.naturalWidth - edge) / 2;
  const sy = (img.naturalHeight - edge) / 2;
  const out = Math.min(size, edge);

  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not read that image");
  ctx.drawImage(img, sx, sy, edge, edge, 0, 0, out, out);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not read that image")),
      "image/jpeg",
      0.85,
    );
  });
}
