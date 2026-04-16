import { promises as fs } from "fs";
import path from "path";

function getUploadsDirectory(): string {
    return path.resolve(process.cwd(), ".uploads", "causal-source");
}

function normalizeFileName(fileName: string): string {
    return fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export async function saveUploadedFile(file: File, itemId: string): Promise<{ storedPath: string; buffer: Buffer }> {
    const uploadsDir = getUploadsDirectory();
    await fs.mkdir(uploadsDir, { recursive: true });

    const safeName = normalizeFileName(file.name || "source.dat");
    const storedName = `${String(Date.now())}-${itemId}-${safeName}`;
    const storedPath = path.join(uploadsDir, storedName);

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await fs.writeFile(storedPath, buffer);

    return {
        storedPath,
        buffer,
    };
}

export async function deleteUploadedFile(storedPath: string): Promise<void> {
    await fs.rm(storedPath, { force: true }).catch(() => undefined);
}
