/**
 * Project files go to the cloud gzip-compressed: they're JSON with base64 audio
 * inside, which shrinks a lot and keeps big projects under the 50 MB file limit.
 * Reading accepts both, so a file that was stored uncompressed still opens.
 */
export async function pack(text: string): Promise<Blob> {
  const plain = new Blob([text]);
  if (typeof CompressionStream === "undefined") return plain;
  return new Response(plain.stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

export async function unpack(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;

  if (!gzipped) return blob.text();
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't open compressed cloud projects. Update your browser.");
  }
  return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}
