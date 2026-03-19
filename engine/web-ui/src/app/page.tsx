"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";

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

type PipelineResult = {
  summary: PipelineSummary;
  entities: string[];
  followUpQuestions: unknown;
  causalCombined: unknown[];
  generatedEntityFiles: Array<{ entity: string; file: string }>;
  stdout: string;
};

type StageEvent = {
  stage: string;
  message?: string;
};

export default function Home() {
  const [inputMode, setInputMode] = useState<"file" | "text">("file");
  const [fileMode, setFileMode] = useState<"audio" | "textFile">("audio");
  const [selectedAudioFile, setSelectedAudioFile] = useState<File | null>(null);
  const [selectedTextFile, setSelectedTextFile] = useState<File | null>(null);
  const [inputText, setInputText] = useState("");
  const [model, setModel] = useState("gemini-3.1-pro");
  const [chunkSizeWords, setChunkSizeWords] = useState("900");
  const [chunkOverlapWords, setChunkOverlapWords] = useState("180");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [stageMessage, setStageMessage] = useState<string>("");
  const [stageHistory, setStageHistory] = useState<StageEvent[]>([]);

  const canSubmit = useMemo(() => {
    if (loading) {
      return false;
    }
    if (inputMode === "file") {
      if (fileMode === "audio") {
        return Boolean(selectedAudioFile);
      }
      return Boolean(selectedTextFile);
    }
    return inputText.trim().length > 0;
  }, [fileMode, inputMode, inputText, loading, selectedAudioFile, selectedTextFile]);

  const onAudioFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedAudioFile(file);
  };

  const onTextFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedTextFile(file);
  };

  const submitPipeline = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    setCurrentStage(null);
    setStageMessage("");
    setStageHistory([]);
    setLoading(true);

    try {
      const formData = new FormData();
      formData.append("inputMode", inputMode);
      formData.append("model", model.trim());
      formData.append("chunkSizeWords", chunkSizeWords.trim());
      formData.append("chunkOverlapWords", chunkOverlapWords.trim());

      if (inputMode === "file") {
        formData.append("fileMode", fileMode);
        if (fileMode === "audio") {
          if (!selectedAudioFile) {
            throw new Error("Please select an audio file.");
          }
          formData.append("audioFile", selectedAudioFile);
        } else {
          if (!selectedTextFile) {
            throw new Error("Please select a text file.");
          }
          formData.append("textFile", selectedTextFile);
        }
      } else {
        formData.append("inputText", inputText);
      }

      const response = await fetch("/api/pipeline/run", {
        method: "POST",
        body: formData,
      });

      const contentType = response.headers.get("content-type") || "";
      if (!response.ok && contentType.includes("application/json")) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || "Pipeline execution failed.");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response stream from pipeline API.");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: string | null = null;
      let streamResult: PipelineResult | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
          const lines = block.split("\n");
          const eventLine = lines.find((line) => line.startsWith("event:"));
          const dataLine = lines.find((line) => line.startsWith("data:"));
          if (!eventLine || !dataLine) {
            continue;
          }

          const eventName = eventLine.replace("event:", "").trim();
          const dataRaw = dataLine.replace("data:", "").trim();
          let data: unknown = null;
          try {
            data = JSON.parse(dataRaw);
          } catch {
            continue;
          }

          if (eventName === "stage") {
            const stage = data as StageEvent;
            setCurrentStage(stage.stage);
            setStageMessage(stage.message || "");
            setStageHistory((previous) => [...previous, stage]);
          }

          if (eventName === "result") {
            streamResult = data as PipelineResult;
          }

          if (eventName === "error") {
            const payload = data as { error?: string };
            streamError = payload.error || "Pipeline execution failed.";
          }
        }
      }

      if (streamError) {
        throw new Error(streamError);
      }

      if (!streamResult) {
        throw new Error("Pipeline completed without a result payload.");
      }

      setResult(streamResult);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
        <header className="rounded-xl border border-slate-800 bg-slate-900 p-6">
          <h1 className="text-2xl font-bold">Pipeline Control Panel</h1>
          <p className="mt-2 text-sm text-slate-300">
            Upload transcript/audio files or paste text, then execute the existing Python pipeline and inspect generated artifacts.
          </p>
        </header>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-6">
          <form onSubmit={submitPipeline} className="grid gap-4">
            <div className="grid gap-2">
              <label className="text-sm font-medium">Input mode</label>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="inputMode"
                    checked={inputMode === "file"}
                    onChange={() => setInputMode("file")}
                  />
                  File upload
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="inputMode"
                    checked={inputMode === "text"}
                    onChange={() => setInputMode("text")}
                  />
                  Direct text
                </label>
              </div>
            </div>

            {inputMode === "file" ? (
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <label className="text-sm font-medium">File type</label>
                  <div className="flex gap-4 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="fileMode"
                        checked={fileMode === "audio"}
                        onChange={() => setFileMode("audio")}
                      />
                      Audio file
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="fileMode"
                        checked={fileMode === "textFile"}
                        onChange={() => setFileMode("textFile")}
                      />
                      Text file
                    </label>
                  </div>
                </div>

                <div className="grid gap-2 rounded-md border border-slate-800 p-3">
                  <label className="text-sm font-medium">Audio file upload block</label>
                  <input
                    className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                    type="file"
                    accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.webm,.mp4"
                    onChange={onAudioFileChange}
                    disabled={fileMode !== "audio"}
                  />
                  <p className="text-xs text-slate-400">Use this block for interview audio input.</p>
                </div>

                <div className="grid gap-2 rounded-md border border-slate-800 p-3">
                  <label className="text-sm font-medium">Text file upload block</label>
                  <input
                    className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                    type="file"
                    accept=".txt"
                    onChange={onTextFileChange}
                    disabled={fileMode !== "textFile"}
                  />
                  <p className="text-xs text-slate-400">Use this block for transcript text files.</p>
                </div>
              </div>
            ) : (
              <div className="grid gap-2">
                <label className="text-sm font-medium">Input text</label>
                <textarea
                  className="min-h-48 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  value={inputText}
                  onChange={(event) => setInputText(event.target.value)}
                  placeholder="Paste transcript text here..."
                />
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-3">
              <div className="grid gap-2">
                <label className="text-sm font-medium">Model</label>
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Chunk size words</label>
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  value={chunkSizeWords}
                  onChange={(event) => setChunkSizeWords(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Chunk overlap words</label>
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  value={chunkOverlapWords}
                  onChange={(event) => setChunkOverlapWords(event.target.value)}
                />
              </div>
            </div>

            <button
              className="inline-flex w-fit items-center justify-center rounded-md bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
              type="submit"
              disabled={!canSubmit}
            >
              {loading ? "Running pipeline..." : "Run pipeline"}
            </button>

            {loading && currentStage ? (
              <div className="rounded-md border border-cyan-700 bg-cyan-950/30 p-3 text-sm text-cyan-100">
                <p className="font-semibold">Current stage: {currentStage}</p>
                {stageMessage ? <p className="mt-1 text-cyan-200">{stageMessage}</p> : null}
              </div>
            ) : null}

            {stageHistory.length > 0 ? (
              <div className="rounded-md border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300">
                <p className="mb-2 font-semibold">Stage history</p>
                <ul className="grid gap-1">
                  {stageHistory.map((stage, index) => (
                    <li key={`${stage.stage}-${String(index)}`}>
                      {index + 1}. {stage.stage}
                      {stage.message ? ` - ${stage.message}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {error ? <p className="rounded-md bg-red-950 p-3 text-sm text-red-200">{error}</p> : null}
          </form>
        </section>

        {result ? (
          <section className="grid gap-4 pb-10 md:grid-cols-2">
            <article className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-lg font-semibold">Run summary</h2>
              <pre className="mt-3 overflow-x-auto rounded-md bg-slate-950 p-3 text-xs">
                {JSON.stringify(result.summary, null, 2)}
              </pre>
            </article>

            <article className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-lg font-semibold">Entities ({result.entities.length})</h2>
              <ul className="mt-3 grid gap-2 text-sm text-slate-200">
                {result.entities.map((entity) => (
                  <li className="rounded-md bg-slate-950 px-3 py-2" key={entity}>
                    {entity}
                  </li>
                ))}
              </ul>
            </article>

            <article className="rounded-xl border border-slate-800 bg-slate-900 p-5 md:col-span-2">
              <h2 className="text-lg font-semibold">Follow-up questions</h2>
              <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-slate-950 p-3 text-xs">
                {JSON.stringify(result.followUpQuestions, null, 2)}
              </pre>
            </article>

            <article className="rounded-xl border border-slate-800 bg-slate-900 p-5 md:col-span-2">
              <h2 className="text-lg font-semibold">Causal combined (first 10)</h2>
              <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-slate-950 p-3 text-xs">
                {JSON.stringify(result.causalCombined.slice(0, 10), null, 2)}
              </pre>
            </article>

            <article className="rounded-xl border border-slate-800 bg-slate-900 p-5 md:col-span-2">
              <h2 className="text-lg font-semibold">Generated entity files</h2>
              <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-slate-950 p-3 text-xs">
                {JSON.stringify(result.generatedEntityFiles, null, 2)}
              </pre>
            </article>
          </section>
        ) : null}
      </main>
    </div>
  );
}
