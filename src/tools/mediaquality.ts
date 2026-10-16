import sharp from "sharp";

/** Decode the image and compare machine-checkable requested constraints. */
export async function inspectGeneratedImage(bytes: Buffer, args: Record<string, any>): Promise<{ format?: string; width?: number; height?: number; hasAlpha?: boolean; decoded: boolean; warnings: string[] }> {
  const image = sharp(bytes, { limitInputPixels: 64_000_000, failOn: "warning" });
  const meta = await image.metadata();
  const stats = await image.stats();
  const warnings: string[] = [];
  const size = /^(\d+)x(\d+)$/i.exec(String(args.size ?? ""));
  if (size && (meta.width !== Number(size[1]) || meta.height !== Number(size[2]))) warnings.push(`Requested ${args.size}, received ${meta.width}x${meta.height}`);
  const ratio = /^(\d+):(\d+)$/.exec(String(args.aspect_ratio ?? ""));
  if (ratio && meta.width && meta.height && Math.abs(meta.width / meta.height / (Number(ratio[1]) / Number(ratio[2])) - 1) > 0.02) warnings.push(`Requested aspect_ratio ${args.aspect_ratio}, received ${meta.width}:${meta.height}`);
  if (args.background === "transparent" && stats.isOpaque) warnings.push("Requested transparency, but the result is opaque");
  if (args.output_format && (String(args.output_format).toLowerCase().replace(/^jpg$/, "jpeg") !== meta.format)) warnings.push(`Requested format ${args.output_format}, received ${meta.format}`);
  return { format: meta.format, width: meta.width, height: meta.height, hasAlpha: meta.hasAlpha, decoded: true, warnings };
}
