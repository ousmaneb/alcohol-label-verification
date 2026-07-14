/**
 * Downscale a photo in the browser before upload. Keeps requests small and
 * responses fast. 1568px is the sweet spot for Claude vision.
 */
export async function prepareImage(
  file: File
): Promise<{ base64: string; mediaType: string; previewUrl: string }> {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1568;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
  return {
    base64: dataUrl.split(",")[1],
    mediaType: "image/jpeg",
    previewUrl: dataUrl,
  };
}
