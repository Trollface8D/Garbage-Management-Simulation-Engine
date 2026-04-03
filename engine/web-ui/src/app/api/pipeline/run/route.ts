import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PipelineSummary = {
  run_dir: string;
  transcript_file: string;
  chunks_file: string;
  causal_by_chunk_file: string;
  causal_combined_file: string;
  follow_up_file: string;
  entities_file: string;
  generated_entities_dir: string;
  generated_entity_count: number;
};

type PipelineResponse = {
  summary: PipelineSummary;
  entities: string[];
  followUpQuestions: unknown;
  causalCombined: unknown[];
  generatedEntityFiles: Array<{ entity: string; file: string }>;
  stdout: string;
};

type StagePayload = {
  stage: string;
  message?: string;
};

function getRepoRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), "..");
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function detectPythonExecutable(repoRoot: string): Promise<string> {
  const configured = process.env.PYTHON_EXECUTABLE;
  if (configured && configured.trim()) {
    return configured;
  }

  const venvPython = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  if (await fileExists(venvPython)) {
    return venvPython;
  }

  return "python";
}

function parseStageMarker(line: string): StagePayload | null {
  const marker = "[PIPELINE_STAGE]";
  if (!line.startsWith(marker)) {
    return null;
  }
  const raw = line.slice(marker.length).trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as StagePayload;
  } catch {
    return { stage: "unknown", message: raw };
  }
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function getLatestRunDir(outputRoot: string): Promise<string> {
  const entries = await fs.readdir(outputRoot, { withFileTypes: true });
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
    .map((entry) => entry.name)
    .sort();

  if (runDirs.length === 0) {
    throw new Error("No run directory was created by the pipeline.");
  }

  return path.join(outputRoot, runDirs[runDirs.length - 1]);
}

async function readJsonFile<T>(jsonPath: string): Promise<T> {
  const raw = await fs.readFile(jsonPath, "utf-8");
  return JSON.parse(raw) as T;
}

export async function POST(request: Request): Promise<Response> {
  const repoRoot = getRepoRoot();
  const engineEntry = path.join(repoRoot, "Engine", "pipeline_engine.py");

  const formData = await request.formData();
  const inputMode = String(formData.get("inputMode") || "file");
  const fileMode = String(formData.get("fileMode") || "audio");
  const inputText = String(formData.get("inputText") || "").trim();
  const model = String(formData.get("model") || "").trim();
  const chunkSizeWords = String(formData.get("chunkSizeWords") || "").trim();
  const chunkOverlapWords = String(formData.get("chunkOverlapWords") || "").trim();

  const outputRoot = path.join(
    repoRoot,
    "Engine",
    "output",
    "web_ui_runs",
    `request_${Date.now()}_${randomUUID().slice(0, 8)}`,
  );

  let tempUploadDir = "";
  const pythonExecutable = await detectPythonExecutable(repoRoot);
  const args = [engineEntry, "--output-root", outputRoot];

  if (model) {
    args.push("--model", model);
  }
  if (chunkSizeWords) {
    args.push("--chunk-size-words", chunkSizeWords);
  }
  if (chunkOverlapWords) {
    args.push("--chunk-overlap-words", chunkOverlapWords);
  }

  if (inputMode === "text") {
    if (!inputText) {
      return Response.json({ error: "Input text is required when input mode is text." }, { status: 400 });
    }
    args.push("--input-type", "text", "--input-text", inputText);
  } else {
    const fileFieldName = fileMode === "textFile" ? "textFile" : "audioFile";
    const file = formData.get(fileFieldName);
    if (!(file instanceof File)) {
      return Response.json({ error: "Please upload a valid file." }, { status: 400 });
    }

    tempUploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-upload-"));
    const uploadedPath = path.join(tempUploadDir, file.name || "input.dat");
    const arrayBuffer = await file.arrayBuffer();
    await fs.writeFile(uploadedPath, Buffer.from(arrayBuffer));

    const pipelineInputType = fileMode === "textFile" ? "text" : "audio";
    args.push("--input-type", pipelineInputType, "--input-path", uploadedPath);
  }

  await fs.mkdir(outputRoot, { recursive: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const child = spawn(pythonExecutable, args, {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";

      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      send("stage", { stage: "starting", message: "Pipeline process started" });

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        lineBuffer += text;

        let newlineIndex = lineBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = lineBuffer.slice(0, newlineIndex).trim();
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          const stagePayload = parseStageMarker(line);
          if (stagePayload) {
            send("stage", stagePayload);
          }
          newlineIndex = lineBuffer.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
      });

      child.on("error", async (error) => {
        send("error", { error: error.message || "Failed to start pipeline process." });
        if (tempUploadDir) {
          await fs.rm(tempUploadDir, { recursive: true, force: true });
        }
        controller.close();
      });

      child.on("close", async (code) => {
        try {
          if (lineBuffer.trim()) {
            const stagePayload = parseStageMarker(lineBuffer.trim());
            if (stagePayload) {
              send("stage", stagePayload);
            }
          }

          if (code !== 0) {
            const failureMessage = `Pipeline process failed with exit code ${String(code)}.\n${stderr || stdout}`;
            send("error", { error: failureMessage });
            return;
          }

          const runDir = await getLatestRunDir(outputRoot);
          const summary = await readJsonFile<PipelineSummary>(path.join(runDir, "summary.json"));
          const entities = await readJsonFile<string[]>(path.join(runDir, "entities.json"));
          const followUpQuestions = await readJsonFile<unknown>(path.join(runDir, "follow_up_questions.json"));
          const causalCombined = await readJsonFile<unknown[]>(path.join(runDir, "causal_combined.json"));
          const generatedEntityFiles = await readJsonFile<Array<{ entity: string; file: string }>>(
            path.join(runDir, "generated_entity_files.json"),
          );

          const response: PipelineResponse = {
            summary,
            entities,
            followUpQuestions,
            causalCombined,
            generatedEntityFiles,
            stdout,
          };

          send("result", response);
          send("done", { ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown pipeline execution error.";
          send("error", { error: message });
        } finally {
          if (tempUploadDir) {
            await fs.rm(tempUploadDir, { recursive: true, force: true });
          }
          controller.close();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
