"use client";

import { useMemo, useState } from "react";

export interface CausalTriple {
  head: string;
  relationship: string;
  tail: string;
  detail: string;
}

export interface CausalItem {
  pattern_type: string;
  sentence_type: string;
  marked_type: string;
  explicit_type: string;
  marker: string | null;
  source_text: string;
  extracted: CausalTriple[];
}

export interface GeneratedQuestionsData {
  source_text: string;
  sentence_type: string;
  generated_questions: string[];
}

type FollowUpGenerationPageProps = {
  initialCausalItems?: CausalItem[];
};

const mockCausalItems: CausalItem[] = [
  {
    pattern_type: "C",
    sentence_type: "SB",
    marked_type: "U",
    explicit_type: "I",
    marker: null,
    source_text: "But it still has not solved the routing bottleneck for night collection shifts.",
    extracted: [
      {
        head: "The compact design of the cage",
        relationship: "causes",
        tail: "difficulty for the cleaners",
        detail: "because it is too small",
      },
    ],
  },
  {
    pattern_type: "C",
    sentence_type: "SP",
    marked_type: "U",
    explicit_type: "I",
    marker: null,
    source_text: "When transfer windows are reduced, truck queues become unpredictable at district hubs.",
    extracted: [
      {
        head: "Reduced transfer windows",
        relationship: "causes",
        tail: "queue instability",
        detail: "because inbound trucks overlap in short time windows",
      },
    ],
  },
  {
    pattern_type: "C",
    sentence_type: "SB",
    marked_type: "U",
    explicit_type: "I",
    marker: null,
    source_text: "Policy changes affect load balancing, but the impact conditions remain unclear.",
    extracted: [
      {
        head: "Changing the policy",
        relationship: "causes",
        tail: "changes in system state",
        detail: "through allocation rules and timing constraints",
      },
    ],
  },
  {
    pattern_type: "C",
    sentence_type: "SP",
    marked_type: "U",
    explicit_type: "I",
    marker: null,
    source_text: "If sorting staff are reduced during peak hours, contamination rates can rise across downstream routes.",
    extracted: [
      {
        head: "Reduced sorting staff",
        relationship: "causes",
        tail: "higher contamination rates",
        detail: "because verification steps are skipped during overload",
      },
    ],
  },
  {
    pattern_type: "C",
    sentence_type: "SB",
    marked_type: "U",
    explicit_type: "I",
    marker: null,
    source_text: "Delayed route reassignment can amplify fuel usage when district demand shifts unexpectedly.",
    extracted: [
      {
        head: "Delayed route reassignment",
        relationship: "causes",
        tail: "increased fuel usage",
        detail: "through repeated detours and idle waiting",
      },
    ],
  },
  {
    pattern_type: "C",
    sentence_type: "SP",
    marked_type: "U",
    explicit_type: "I",
    marker: null,
    source_text: "When transfer hubs lack synchronized unloading windows, cross-zone pickup plans become unstable.",
    extracted: [
      {
        head: "Unsynchronized unloading windows",
        relationship: "causes",
        tail: "cross-zone pickup instability",
        detail: "because vehicles miss planned handoff intervals",
      },
    ],
  },
];

function GoogleGIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 18 18">
      <path
        d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.1 4.1 0 0 1-1.79 2.69v2.23h2.9c1.69-1.55 2.69-3.83 2.69-6.56Z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.47-.8 5.95-2.17l-2.9-2.23c-.8.54-1.82.86-3.05.86-2.35 0-4.34-1.58-5.06-3.71H.95v2.3A9 9 0 0 0 9 18Z"
        fill="#34A853"
      />
      <path
        d="M3.94 10.75a5.39 5.39 0 0 1 0-3.5v-2.3H.95a9 9 0 0 0 0 8.1l2.99-2.3Z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.32 0 2.51.45 3.44 1.34l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .95 4.95l2.99 2.3C4.66 5.16 6.65 3.58 9 3.58Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function CausalCard({
  causal,
  index,
  generatedQuestions,
  isPanelOpen,
  onTogglePanel,
  onGenerateForCausal,
  isGeneratingForCausal,
  answers,
  onAnswerChange,
  onSubmitGroup,
  groupSubmitMessage,
}: {
  causal: CausalItem;
  index: number;
  generatedQuestions: string[];
  isPanelOpen: boolean;
  onTogglePanel: () => void;
  onGenerateForCausal: () => void;
  isGeneratingForCausal: boolean;
  answers: Record<string, string>;
  onAnswerChange: (question: string, answer: string) => void;
  onSubmitGroup: () => void;
  groupSubmitMessage: string;
}) {
  const extracted = causal.extracted[0];
  const hasQuestions = generatedQuestions.length > 0;
  const panelLabel = hasQuestions
    ? `Generated questions (${String(generatedQuestions.length)})`
    : "Generated questions";

  return (
    <article className="rounded-xl border-2 border-neutral-700 bg-neutral-900/80 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onGenerateForCausal}
          disabled={isGeneratingForCausal}
          className="inline-flex items-center rounded-md border border-emerald-600 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:border-neutral-700 disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {isGeneratingForCausal ? "Generating..." : "Generate question"}
        </button>
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Causal {String(index + 1)}</span>
      </div>

      <p className="mb-3 rounded-lg border border-neutral-700 bg-neutral-950/90 p-3 text-sm text-neutral-200">
        {causal.source_text}
      </p>

      {extracted ? (
        <div className="grid gap-2 text-xs text-neutral-300 sm:grid-cols-2">
          <p className="rounded-md border border-neutral-800 bg-neutral-950/70 p-2">
            <span className="font-semibold text-neutral-100">Head:</span> {extracted.head}
          </p>
          <p className="rounded-md border border-neutral-800 bg-neutral-950/70 p-2">
            <span className="font-semibold text-neutral-100">Relation:</span> {extracted.relationship}
          </p>
          <p className="rounded-md border border-neutral-800 bg-neutral-950/70 p-2">
            <span className="font-semibold text-neutral-100">Tail:</span> {extracted.tail}
          </p>
          <p className="rounded-md border border-neutral-800 bg-neutral-950/70 p-2">
            <span className="font-semibold text-neutral-100">Detail:</span> {extracted.detail}
          </p>
        </div>
      ) : null}

      <div className="mt-4 overflow-hidden rounded-lg border border-sky-700/40 bg-neutral-900/85">
        <button
          type="button"
          onClick={onTogglePanel}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-neutral-800/60"
          aria-expanded={isPanelOpen}
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-sky-300">{panelLabel}</span>
          <span className="text-xs text-neutral-300">{isPanelOpen ? "Hide" : "Show"}</span>
        </button>

        {isPanelOpen ? (
          <div className="border-t border-neutral-700 p-3">
            {isGeneratingForCausal ? (
              <p className="text-sm text-neutral-400">Generating questions...</p>
            ) : null}

            {!isGeneratingForCausal && !hasQuestions ? (
              <p className="text-sm text-amber-200">No generated questions for this causal yet.</p>
            ) : null}

            {hasQuestions ? (
              <div className="space-y-2">
                {generatedQuestions.map((question) => (
                  <div key={question} className="rounded-lg border border-neutral-700 bg-neutral-950/90 p-2">
                    <p className="text-sm text-neutral-100">{question}</p>
                    <textarea
                      value={answers[question] ?? ""}
                      onChange={(event) => onAnswerChange(question, event.target.value)}
                      rows={1}
                      className="mt-2 h-10 w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
                      placeholder="Type answer for this question"
                    />
                  </div>
                ))}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={onSubmitGroup}
                    className="rounded-md border border-sky-600 bg-sky-500/10 px-3 py-2 text-xs font-bold uppercase tracking-wide text-sky-200 transition hover:bg-sky-500/20"
                  >
                    Submit this question group
                  </button>
                  <span className="text-xs text-neutral-400">Provide answers for all questions before submit.</span>
                </div>

                {groupSubmitMessage ? <p className="text-xs text-emerald-300">{groupSubmitMessage}</p> : null}

                <span className="flex justify-end text-neutral-300" title="Generated by Google model">
                  <GoogleGIcon />
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

async function buildMockGeneratedResults(selectedItems: CausalItem[]): Promise<GeneratedQuestionsData[]> {
  await new Promise((resolve) => setTimeout(resolve, 900));

  return selectedItems.map((item) => {
    const focusEntity = item.extracted[0]?.head ?? "this factor";
    const targetEntity = item.extracted[0]?.tail ?? "the system state";

    return {
      source_text: item.source_text,
      sentence_type: "SP",
      generated_questions: [
        `How exactly does ${focusEntity} lead to improvements in ${targetEntity} within the simulation?`,
        `What specific assumptions are made when predicting how ${focusEntity} affects ${targetEntity}?`,
        `Under what operating constraints does ${focusEntity} stop influencing ${targetEntity} as expected?`,
        `What additional data should be collected to validate the causal path from ${focusEntity} to ${targetEntity}?`,
      ],
    };
  });
}

export default function FollowUpGenerationPage({ initialCausalItems = mockCausalItems }: FollowUpGenerationPageProps) {
  const [generatedResults, setGeneratedResults] = useState<GeneratedQuestionsData[]>([]);
  const [openedPanels, setOpenedPanels] = useState<Set<string>>(() => new Set());
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [generatingSources, setGeneratingSources] = useState<Set<string>>(() => new Set());
  const [isFiltering, setIsFiltering] = useState(false);
  const [answersBySource, setAnswersBySource] = useState<Record<string, Record<string, string>>>({});
  const [groupSubmitStatus, setGroupSubmitStatus] = useState<Record<string, string>>({});
  const [allSubmitStatus, setAllSubmitStatus] = useState("");

  const hasGenerated = generatedResults.length > 0;

  const generatedBySourceText = useMemo(() => {
    return new Map(generatedResults.map((result) => [result.source_text, result]));
  }, [generatedResults]);

  const handleGenerateAllQuestions = async () => {
    setIsGeneratingAll(true);

    const results = await buildMockGeneratedResults(initialCausalItems);
    setGeneratedResults(results);
    setOpenedPanels(new Set(results.map((result) => result.source_text)));
    setGroupSubmitStatus({});
    setAllSubmitStatus("");
    setIsGeneratingAll(false);
  };

  const handleGenerateForCausal = async (causal: CausalItem) => {
    setGeneratingSources((previous) => {
      const next = new Set(previous);
      next.add(causal.source_text);
      return next;
    });

    const [result] = await buildMockGeneratedResults([causal]);

    if (result) {
      setGeneratedResults((previous) => {
        const bySource = new Map(previous.map((item) => [item.source_text, item]));
        bySource.set(result.source_text, result);

        return initialCausalItems
          .map((item) => bySource.get(item.source_text))
          .filter((item): item is GeneratedQuestionsData => Boolean(item));
      });

      setOpenedPanels((previous) => {
        const next = new Set(previous);
        next.add(causal.source_text);
        return next;
      });
    }

    setGeneratingSources((previous) => {
      const next = new Set(previous);
      next.delete(causal.source_text);
      return next;
    });
  };

  const handleAnswerChange = (sourceText: string, question: string, answer: string) => {
    setAnswersBySource((previous) => ({
      ...previous,
      [sourceText]: {
        ...(previous[sourceText] ?? {}),
        [question]: answer,
      },
    }));
  };

  const toggleGeneratedPanel = (sourceText: string) => {
    setOpenedPanels((previous) => {
      const next = new Set(previous);
      if (next.has(sourceText)) {
        next.delete(sourceText);
      } else {
        next.add(sourceText);
      }
      return next;
    });
  };

  const handleRunFilter = async () => {
    if (!hasGenerated) {
      return;
    }

    setIsFiltering(true);
    await new Promise((resolve) => setTimeout(resolve, 650));

    const filtered = generatedResults.map((result) => {
      const keptQuestions = result.generated_questions.filter((question) =>
        /(simulation|system|policy|state|assumption|predict)/i.test(question),
      );

      return {
        ...result,
        generated_questions: keptQuestions.length > 0 ? keptQuestions : result.generated_questions.slice(0, 1),
      };
    });

    setGeneratedResults(filtered);
    setIsFiltering(false);
  };

  const handleSubmitGroup = (sourceText: string, questions: string[]) => {
    if (questions.length === 0) {
      setGroupSubmitStatus((previous) => ({
        ...previous,
        [sourceText]: "No generated questions to submit for this causal.",
      }));
      return;
    }

    const answers = answersBySource[sourceText] ?? {};
    const unansweredCount = questions.filter((question) => !(answers[question] ?? "").trim()).length;

    if (unansweredCount > 0) {
      setGroupSubmitStatus((previous) => ({
        ...previous,
        [sourceText]: `Please answer ${String(unansweredCount)} more question(s) before submitting this group.`,
      }));
      return;
    }

    setGroupSubmitStatus((previous) => ({
      ...previous,
      [sourceText]: `Submitted ${String(questions.length)} Q&A item(s) for this causal.`,
    }));
  };

  const handleSubmitAllQA = () => {
    if (!hasGenerated) {
      setAllSubmitStatus("No generated questions available to submit yet.");
      return;
    }

    const qaPairs = generatedResults.flatMap((result) =>
      result.generated_questions.map((question) => ({
        sourceText: result.source_text,
        question,
      })),
    );

    const unansweredCount = qaPairs.filter(({ sourceText, question }) => {
      const answer = answersBySource[sourceText]?.[question] ?? "";
      return !answer.trim();
    }).length;

    if (unansweredCount > 0) {
      setAllSubmitStatus(`Please answer ${String(unansweredCount)} remaining question(s) before submitting all.`);
      return;
    }

    setAllSubmitStatus(`Submitted all Question & Answer successfully (${String(qaPairs.length)} item(s)).`);
  };

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 backdrop-blur-sm md:p-6">
      <header className="mx-auto mb-6 max-w-3xl text-center">
        <h2 className="text-xl font-bold text-neutral-100 md:text-2xl">Follow-up question section</h2>
        <p className="mt-2 text-sm text-neutral-300">
          You can generate follow-up questions for implicit information based on your input, and the engine will
          generate analytical questions for you to obtain more useful information and accuracy. (This part is optional)
        </p>
      </header>

      <div>
        <div>
          <p className="mb-3 text-sm font-semibold text-neutral-200">Select implicit causal for question generation</p>
          <div className="space-y-3">
            {initialCausalItems.map((causal, index) => {
              const generated = generatedBySourceText.get(causal.source_text);

              return (
                <CausalCard
                  key={causal.source_text}
                  causal={causal}
                  index={index}
                  generatedQuestions={generated?.generated_questions ?? []}
                  isPanelOpen={openedPanels.has(causal.source_text)}
                  onTogglePanel={() => toggleGeneratedPanel(causal.source_text)}
                  onGenerateForCausal={() => void handleGenerateForCausal(causal)}
                  isGeneratingForCausal={generatingSources.has(causal.source_text)}
                  answers={answersBySource[causal.source_text] ?? {}}
                  onAnswerChange={(question, answer) => handleAnswerChange(causal.source_text, question, answer)}
                  onSubmitGroup={() => handleSubmitGroup(causal.source_text, generated?.generated_questions ?? [])}
                  groupSubmitMessage={groupSubmitStatus[causal.source_text] ?? ""}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleGenerateAllQuestions}
            disabled={isGeneratingAll}
            className="rounded-lg border border-emerald-500 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:border-neutral-700 disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {isGeneratingAll ? "Generating..." : "Generate all questions"}
          </button>

          <button
            type="button"
            onClick={handleRunFilter}
            disabled={isFiltering || !hasGenerated || generatedResults.length === 0}
            className="rounded-lg border border-sky-500 bg-sky-500/20 px-4 py-2 text-sm font-bold text-sky-200 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:border-neutral-700 disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {isFiltering ? "RUNNING FILTER..." : "Run filter"}
          </button>
        </div>

        <button
          type="button"
          onClick={handleSubmitAllQA}
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-5 py-2 text-sm font-bold tracking-wide text-neutral-100 transition hover:border-neutral-500"
        >
          Submit all Question & Answer
        </button>
      </div>

      {allSubmitStatus ? <p className="mt-3 text-sm text-neutral-300">{allSubmitStatus}</p> : null}
    </section>
  );
}
