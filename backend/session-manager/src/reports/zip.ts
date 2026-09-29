import archiver from "archiver";

/** [file name, contents] of one zip member. */
export type ZipEntry = [string, string];

export async function zipFiles(entries: ZipEntry[]): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", reject);
  });
  for (const [name, contents] of entries) archive.append(contents, { name });
  await archive.finalize();
  await finished;
  return Buffer.concat(chunks);
}
