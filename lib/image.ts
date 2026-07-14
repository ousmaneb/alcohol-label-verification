/**
 * lib/image.ts — prepares label photos in the browser before upload.
 *
 * A phone photo can be 12 megapixels (several MB). Sending that over the
 * network and into the AI model would be slow and would cost extra tokens,
 * with no accuracy benefit: Claude vision works best at up to ~1568px on
 * the long edge. So we resize the photo on the agent's own machine first:
 *
 *   1. decode the file into a bitmap
 *   2. draw it onto an invisible <canvas> at the reduced size
 *   3. re-encode as JPEG and return it as base64 text (what the API expects)
 *
 * Photos smaller than 1568px are left at their original size
 * (Math.min(1, ...) prevents upscaling). The previewUrl is the same image
 * as a data: URL, used to show the thumbnail in the form.
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
