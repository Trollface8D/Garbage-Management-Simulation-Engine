"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadFollowUpRecordsForItem,
  saveFollowUpAnswersForItem,
  saveFollowUpQuestionsForItem,
  type FollowUpRecord,
} from "@/lib/pm-storage";

export interface CausalTriple {
  head: string;
  relationship: string;
  tail: string;
  detail: string;
}

export interface CausalItem {
  chunk_label?: string;
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

type DerivedExtractionBySourceQuestion = Record<string, Record<string, CausalItem[]>>;

type FollowUpGenerationPageProps = {
  initialCausalItems?: CausalItem[];
  includeImplicit?: boolean;
  experimentItemId?: string;
  initialFollowUpRecords?: FollowUpRecord[];
  model?: string;
};

type AnswerFilterMode = "all" | "unanswered" | "answered";

type FollowUpDraftPayload = {
  answersBySource: Record<string, Record<string, string>>;
  updatedAt: string;
};

const DRAFT_SYNC_THRESHOLD = 3;
const DRAFT_SYNC_DEBOUNCE_MS = 800;

function getFollowUpDraftStorageKey(experimentItemId?: string): string | null {
  const itemId = (experimentItemId || "").trim();
  if (!itemId) {
    return null;
  }

  return `pm.follow-up.drafts:${itemId}`;
}

function readFollowUpDraftFromStorage(experimentItemId?: string): FollowUpDraftPayload | null {
  if (typeof window === "undefined") {
    return null;
  }

  const key = getFollowUpDraftStorageKey(experimentItemId);
  if (!key) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const payload = JSON.parse(raw) as FollowUpDraftPayload;
    if (!payload || typeof payload !== "object" || typeof payload.answersBySource !== "object") {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function writeFollowUpDraftToStorage(experimentItemId: string, answersBySource: Record<string, Record<string, string>>): void {
  if (typeof window === "undefined") {
    return;
  }

  const key = getFollowUpDraftStorageKey(experimentItemId);
  if (!key) {
    return;
  }

  const payload: FollowUpDraftPayload = {
    answersBySource,
    updatedAt: new Date().toISOString(),
  };

  try {
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors to avoid blocking typing.
  }
}

function mergeAnswersByPriority(
  serverAnswers: Record<string, Record<string, string>>,
  localDraftAnswers: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const merged: Record<string, Record<string, string>> = {};

  const sourceKeys = new Set([...Object.keys(localDraftAnswers), ...Object.keys(serverAnswers)]);
  for (const sourceText of sourceKeys) {
    const localQuestions = localDraftAnswers[sourceText] ?? {};
    const serverQuestions = serverAnswers[sourceText] ?? {};
    const questionKeys = new Set([...Object.keys(localQuestions), ...Object.keys(serverQuestions)]);
    const byQuestion: Record<string, string> = {};

    for (const question of questionKeys) {
      const serverValue = serverQuestions[question] ?? "";
      const hasLocalValue = Object.prototype.hasOwnProperty.call(localQuestions, question);
      byQuestion[question] = hasLocalValue ? (localQuestions[question] ?? "") : serverValue;
    }

    merged[sourceText] = byQuestion;
  }

  return merged;
}

function toGeneratedResults(records: FollowUpRecord[]): GeneratedQuestionsData[] {
  const bySource = new Map<string, { sentenceType: string; questions: string[]; questionSet: Set<string> }>();

  for (const record of records) {
    const sourceText = (record.sourceText || "").trim();
    if (!sourceText) {
      continue;
    }

    const existing = bySource.get(sourceText) ?? {
      sentenceType: (record.sentenceType || "").trim(),
      questions: [],
      questionSet: new Set<string>(),
    };

    for (const question of record.questions ?? []) {
      const text = (question.questionText || "").trim();
      if (!text || existing.questionSet.has(text)) {
        continue;
      }

      existing.questionSet.add(text);
      existing.questions.push(text);
    }

    bySource.set(sourceText, existing);
  }

  return Array.from(bySource.entries()).map(([sourceText, value]) => ({
    source_text: sourceText,
    sentence_type: value.sentenceType,
    generated_questions: value.questions,
  }));
}

function toAnswersMap(records: FollowUpRecord[]): Record<string, Record<string, string>> {
  const answers: Record<string, Record<string, string>> = {};

  for (const record of records) {
    const sourceText = (record.sourceText || "").trim();
    if (!sourceText) {
      continue;
    }

    for (const question of record.questions ?? []) {
      const questionText = (question.questionText || "").trim();
      if (!questionText) {
        continue;
      }

      if (!answers[sourceText]) {
        answers[sourceText] = {};
      }

      answers[sourceText][questionText] = question.answerText ?? "";
    }
  }

  return answers;
}

function toQuestionIdMap(records: FollowUpRecord[]): Record<string, Record<string, string>> {
  const questionIds: Record<string, Record<string, string>> = {};

  for (const record of records) {
    const sourceText = (record.sourceText || "").trim();
    if (!sourceText) {
      continue;
    }

    for (const question of record.questions ?? []) {
      const questionText = (question.questionText || "").trim();
      const questionId = (question.questionId || "").trim();
      if (!questionText || !questionId) {
        continue;
      }

      if (!questionIds[sourceText]) {
        questionIds[sourceText] = {};
      }

      questionIds[sourceText][questionText] = questionId;
    }
  }

  return questionIds;
}

function toDerivedExtractionMap(records: FollowUpRecord[]): DerivedExtractionBySourceQuestion {
  const derived: DerivedExtractionBySourceQuestion = {};

  for (const record of records) {
    const sourceText = (record.sourceText || "").trim();
    if (!sourceText) {
      continue;
    }

    for (const question of record.questions ?? []) {
      const questionText = (question.questionText || "").trim();
      if (!questionText) {
        continue;
      }

      const derivedRows = Array.isArray(question.derivedCausal)
        ? question.derivedCausal.map((row) => ({
            pattern_type: row.pattern_type,
            sentence_type: row.sentence_type,
            marked_type: row.marked_type,
            explicit_type: row.explicit_type,
            marker: row.marker || null,
            source_text: row.source_text,
            extracted: (row.extracted ?? []).map((relation) => ({
              head: relation.head,
              relationship: relation.relationship,
              tail: relation.tail,
              detail: relation.detail,
            })),
          }))
        : [];

      if (derivedRows.length === 0) {
        continue;
      }

      if (!derived[sourceText]) {
        derived[sourceText] = {};
      }

      derived[sourceText][questionText] = derivedRows;
    }
  }

  return derived;
}

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
  filterAnswers,
  onAnswerChange,
  onAnswerBlur,
  newQuestionDraft,
  onNewQuestionDraftChange,
  onAddQuestionSet,
  onSubmitGroup,
  groupSubmitMessage,
  derivedExtractionByQuestion,
  answerFilterMode,
  totalAnsweredCount,
  totalUnansweredCount,
  isAddedToCausalStructure,
}: {
  causal: CausalItem;
  index: number;
  generatedQuestions: string[];
  isPanelOpen: boolean;
  onTogglePanel: () => void;
  onGenerateForCausal: () => void;
  isGeneratingForCausal: boolean;
  answers: Record<string, string>;
  filterAnswers: Record<string, string>;
  onAnswerChange: (question: string, answer: string) => void;
  onAnswerBlur: () => void;
  newQuestionDraft: string;
  onNewQuestionDraftChange: (value: string) => void;
  onAddQuestionSet: () => void;
  onSubmitGroup: () => void;
  groupSubmitMessage: string;
  derivedExtractionByQuestion: Record<string, CausalItem[]>;
  answerFilterMode: AnswerFilterMode;
  totalAnsweredCount: number;
  totalUnansweredCount: number;
  isAddedToCausalStructure: boolean;
}) {
  const filteredQuestions = generatedQuestions.filter((question) => {
    const isAnswered = (filterAnswers[question] ?? "").trim().length > 0;
    if (answerFilterMode === "all") {
      return true;
    }

    return answerFilterMode === "answered" ? isAnswered : !isAnswered;
  });

  const hasQuestions = generatedQuestions.length > 0;
  const hasFilteredQuestions = filteredQuestions.length > 0;
  const panelLabel = hasQuestions
    ? `Generated questions (${String(generatedQuestions.length)})`
    : "Generated questions";

  return (
    <article className="rounded-xl border border-neutral-700 bg-neutral-900/80 p-4 text-sm text-neutral-200">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {causal.chunk_label ? (
            <span className="inline-flex rounded-full border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-300">
              {causal.chunk_label}
            </span>
          ) : null}
          <span className="inline-flex rounded-full border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-300">
            class {String(index + 1)}
          </span>
          {isAddedToCausalStructure ? (
            <span className="inline-flex rounded-full border border-emerald-700 bg-emerald-500/20 px-2 py-1 text-[11px] uppercase tracking-wide text-emerald-200">
              Added to causal structure
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onGenerateForCausal}
          disabled={isGeneratingForCausal}
          className="inline-flex items-center rounded-md border border-emerald-600 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:border-neutral-700 disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {isGeneratingForCausal ? "Generating..." : "Generate question"}
        </button>
      </div>

      <dl className="grid gap-3 md:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">pattern_type</dt>
          <dd className="mt-1 font-semibold text-neutral-100">{causal.pattern_type}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">sentence_type</dt>
          <dd className="mt-1 font-semibold text-neutral-100">{causal.sentence_type}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">marked_type</dt>
          <dd className="mt-1 font-semibold text-neutral-100">{causal.marked_type}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">explicit_type</dt>
          <dd className="mt-1 font-semibold text-neutral-100">{causal.explicit_type}</dd>
        </div>
      </dl>

      <div className="mt-4">
        <p className="text-xs uppercase tracking-wide text-neutral-400">marker</p>
        <p className="mt-1 text-neutral-100">{causal.marker || "-"}</p>
      </div>

      <div className="mt-4">
        <p className="text-xs uppercase tracking-wide text-neutral-400">source_text</p>
        <p className="mt-1 rounded-md border border-neutral-700 bg-neutral-800/70 p-3 text-neutral-200">
          {causal.source_text}
        </p>
      </div>

      <div className="mt-4 rounded-lg border border-neutral-700 bg-neutral-800/70 p-4">
        <p className="text-xs uppercase tracking-wide text-neutral-400">extracted</p>
        <div className="mt-3 space-y-3">
          {causal.extracted.length === 0 ? (
            <p className="text-xs text-neutral-400">No extracted relations returned.</p>
          ) : null}
          {causal.extracted.map((relation, relationIndex) => (
            <dl
              key={`${causal.source_text}-${String(index)}-${String(relationIndex)}`}
              className="rounded-md border border-neutral-700 bg-neutral-900/70 p-3"
            >
              <div>
                <dt className="text-xs text-neutral-400">head</dt>
                <dd className="text-neutral-100">{relation.head}</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-400">relationship</dt>
                <dd className="text-neutral-100">{relation.relationship}</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-400">tail</dt>
                <dd className="text-neutral-100">{relation.tail}</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-400">detail</dt>
                <dd className="text-neutral-100">{relation.detail}</dd>
              </div>
            </dl>
          ))}
        </div>
      </div>

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
            <div className="mb-3 flex items-center gap-2">
              <input
                type="text"
                value={newQuestionDraft}
                onChange={(event) => onNewQuestionDraftChange(event.target.value)}
                placeholder="Type a new follow-up question"
                className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
              />
              <button
                type="button"
                onClick={onAddQuestionSet}
                disabled={!newQuestionDraft.trim()}
                title="Add new question and answer box"
                aria-label="Add new question and answer box"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-sky-600 bg-sky-500/10 text-lg font-bold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:border-neutral-700 disabled:bg-neutral-800 disabled:text-neutral-500"
              >
                +
              </button>
            </div>

            {isGeneratingForCausal ? (
              <p className="text-sm text-neutral-400">Generating questions...</p>
            ) : null}

            {!isGeneratingForCausal && !hasQuestions ? (
              <p className="text-sm text-amber-200">No generated questions for this causal yet.</p>
            ) : null}

            {hasQuestions ? (
              <div className="space-y-2">
                <p className="text-xs text-neutral-400">
                  Showing {answerFilterMode === "all" ? "all" : answerFilterMode} questions: {String(filteredQuestions.length)} of {String(generatedQuestions.length)} (answered {String(totalAnsweredCount)}, unanswered {String(totalUnansweredCount)})
                </p>

                {hasFilteredQuestions ? filteredQuestions.map((question) => (
                  <div key={question} className="rounded-lg border border-neutral-700 bg-neutral-950/90 p-2">
                    <p className="text-sm text-neutral-100">{question}</p>
                    <textarea
                      value={answers[question] ?? ""}
                      onChange={(event) => onAnswerChange(question, event.target.value)}
                      onBlur={onAnswerBlur}
                      rows={1}
                      className="mt-2 h-10 w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
                      placeholder="Type answer for this question"
                    />

                    {(derivedExtractionByQuestion[question] ?? []).length > 0 ? (
                      <div className="mt-2 rounded-md border border-emerald-700/60 bg-emerald-500/10 p-2">
                        <div className="mb-2 inline-flex rounded-full border border-emerald-700 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
                          follow-up derived
                        </div>
                        <div className="space-y-2">
                          {(derivedExtractionByQuestion[question] ?? []).map((derivedItem, derivedIndex) => (
                            <div
                              key={`${question}-derived-${String(derivedIndex)}`}
                              className="rounded-md border border-neutral-700 bg-neutral-900/70 p-2"
                            >
                              <p className="text-[11px] text-neutral-300">marker: {derivedItem.marker || "-"}</p>
                              {(derivedItem.extracted ?? []).length === 0 ? (
                                <p className="mt-1 text-xs text-neutral-400">No extracted relation returned.</p>
                              ) : (
                                <div className="mt-1 space-y-1">
                                  {derivedItem.extracted.map((relation, relationIndex) => (
                                    <p
                                      key={`${question}-derived-${String(derivedIndex)}-relation-${String(relationIndex)}`}
                                      className="text-xs text-neutral-200"
                                    >
                                      {relation.head} | {relation.relationship} | {relation.tail}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )) : (
                  <p className="text-sm text-neutral-400">
                    No {answerFilterMode} questions in this group right now.
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={onSubmitGroup}
                    className="rounded-md border border-sky-600 bg-sky-500/10 px-3 py-2 text-xs font-bold uppercase tracking-wide text-sky-200 transition hover:bg-sky-500/20"
                  >
                    Submit answered in this group
                  </button>
                  <span className="text-xs text-neutral-400">Unanswered items stay as drafts and can be submitted later.</span>
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

async function requestGeneratedQuestions(causalItems: CausalItem[], model?: string): Promise<GeneratedQuestionsData[]> {
  const response = await fetch("/api/causal-extract/follow-up", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      causalItems,
      model: model?.trim() || undefined,
    }),
  });

  const payload = (await response.json().catch(() => null)) as
    | { records?: GeneratedQuestionsData[]; error?: string; detail?: string }
    | null;

  if (!response.ok) {
    const detail = payload?.detail ? ` ${payload.detail}` : "";
    throw new Error(payload?.error ? `${payload.error}${detail}` : `Follow-up generation failed (${String(response.status)}).`);
  }

  return Array.isArray(payload?.records) ? payload.records : [];
}

async function submitFollowUpAnswersWithReextract(input: {
  experimentItemId: string;
  answers: Array<{
    questionId: string;
    questionText: string;
    sourceText: string;
    answerText: string;
    answeredBy?: string;
  }>;
  model?: string;
}): Promise<{ savedAnswers: number; extractedFromFollowUp: number }> {
  const response = await fetch("/api/causal-extract/follow-up-submit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const payload = (await response.json().catch(() => null)) as
    | { savedAnswers?: number; extractedFromFollowUp?: number; error?: string; detail?: string }
    | null;

  if (!response.ok) {
    const detail = payload?.detail ? ` ${payload.detail}` : "";
    throw new Error(payload?.error ? `${payload.error}${detail}` : `Follow-up submit failed (${String(response.status)}).`);
  }

  return {
    savedAnswers: typeof payload?.savedAnswers === "number" ? payload.savedAnswers : 0,
    extractedFromFollowUp:
      typeof payload?.extractedFromFollowUp === "number" ? payload.extractedFromFollowUp : 0,
  };
}

function toCausalRef(causal: CausalItem):
  | {
      head: string;
      relationship: string;
      tail: string;
      detail: string;
    }
  | undefined {
  const relation = causal.extracted[0];
  if (!relation) {
    return undefined;
  }

  return {
    head: relation.head,
    relationship: relation.relationship,
    tail: relation.tail,
    detail: relation.detail,
  };
}

function isLikelyInternetAnswerable(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const internetAnswerableSignals = [
    /\bwhat is\b/,
    /\bdefine\b|\bdefinition\b/,
    /\bexplain\b.*\bconcept\b/,
    /\bhistory of\b/,
    /\bglobal\b|\bworldwide\b/,
    /\bstandard\b|\bguideline\b|\bbest practice\b/,
    /\blaw\b|\bregulation\b|\bpolicy framework\b/,
    /\bstatistics\b|\btrend\b|\bmarket data\b/,
    /\bexample\b|\bcase study\b/,
    /\bcompare\b.*\bcountr(?:y|ies)\b/,
    /\bpublic data\b|\bopen data\b/,
  ];

  const internalContextSignals = [
    /\bthis simulation\b|\bour simulation\b/,
    /\bthis project\b|\bour project\b/,
    /\bthis causal\b|\bcausal path\b/,
    /\binput text\b|\bsource text\b/,
    /\boperating constraints\b|\bassumptions? used here\b/,
    /\bvalidate\b.*\bfrom (?:our|this) data\b/,
  ];

  if (internalContextSignals.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  return internetAnswerableSignals.some((pattern) => pattern.test(normalized));
}

export default function FollowUpGenerationPage({
  initialCausalItems = [],
  includeImplicit = true,
  experimentItemId,
  initialFollowUpRecords = [],
  model = "",
}: FollowUpGenerationPageProps) {
  const [generatedResults, setGeneratedResults] = useState<GeneratedQuestionsData[]>(() => toGeneratedResults(initialFollowUpRecords));
  const [questionIdsBySource, setQuestionIdsBySource] = useState<Record<string, Record<string, string>>>(() =>
    toQuestionIdMap(initialFollowUpRecords),
  );
  const [openedPanels, setOpenedPanels] = useState<Set<string>>(() =>
    new Set(toGeneratedResults(initialFollowUpRecords).map((result) => result.source_text)),
  );
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [generatingSources, setGeneratingSources] = useState<Set<string>>(() => new Set());
  const [isFiltering, setIsFiltering] = useState(false);
  const [answersBySource, setAnswersBySource] = useState<Record<string, Record<string, string>>>(() =>
    toAnswersMap(initialFollowUpRecords),
  );
  const [newQuestionDraftBySource, setNewQuestionDraftBySource] = useState<Record<string, string>>({});
  const [groupSubmitStatus, setGroupSubmitStatus] = useState<Record<string, string>>({});
  const [allSubmitStatus, setAllSubmitStatus] = useState("");
  const [generationStatus, setGenerationStatus] = useState("");
  const [draftSyncStatus, setDraftSyncStatus] = useState("");
  const [answerFilterMode, setAnswerFilterMode] = useState<AnswerFilterMode>("all");
  const [submittedSources, setSubmittedSources] = useState<Set<string>>(() => new Set());
  const [filterBasisAnswersBySource, setFilterBasisAnswersBySource] = useState<Record<string, Record<string, string>>>(() =>
    toAnswersMap(initialFollowUpRecords),
  );
  const [derivedExtractionBySourceQuestion, setDerivedExtractionBySourceQuestion] = useState<DerivedExtractionBySourceQuestion>(
    () => toDerivedExtractionMap(initialFollowUpRecords),
  );

  const answersBySourceRef = useRef<Record<string, Record<string, string>>>(answersBySource);
  const questionIdsBySourceRef = useRef<Record<string, Record<string, string>>>(questionIdsBySource);
  const generatedResultsRef = useRef<GeneratedQuestionsData[]>(generatedResults);
  const draftDebounceTimerRef = useRef<number | null>(null);
  const dirtyAnswerKeysRef = useRef<Set<string>>(new Set());
  const isDraftSyncInFlightRef = useRef(false);
  const shouldDraftSyncAgainRef = useRef(false);
  const flushDraftNowRef = useRef<(reason: "blur" | "leave" | "submit") => void>(() => {});

  const hasGenerated = generatedResults.some((result) => result.generated_questions.length > 0);

  useEffect(() => {
    const hydratedResults = toGeneratedResults(initialFollowUpRecords);
    const serverAnswers = toAnswersMap(initialFollowUpRecords);
    const localDraft = readFollowUpDraftFromStorage(experimentItemId);
    const mergedAnswers = mergeAnswersByPriority(serverAnswers, localDraft?.answersBySource ?? {});

    setGeneratedResults(hydratedResults);
    setQuestionIdsBySource(toQuestionIdMap(initialFollowUpRecords));
    setAnswersBySource(mergedAnswers);
    setFilterBasisAnswersBySource(mergedAnswers);
    setDerivedExtractionBySourceQuestion(toDerivedExtractionMap(initialFollowUpRecords));
    setOpenedPanels(new Set(hydratedResults.map((result) => result.source_text)));
    setNewQuestionDraftBySource({});
    setGroupSubmitStatus({});
    setAllSubmitStatus("");
    setGenerationStatus("");
    setDraftSyncStatus(localDraft ? "Loaded local draft answers." : "");

    const initialSubmittedSources = new Set<string>();
    for (const record of initialFollowUpRecords) {
      if ((record.questions ?? []).some((question) => (question.answerText ?? "").trim().length > 0)) {
        initialSubmittedSources.add(record.sourceText);
      }
    }
    setSubmittedSources(initialSubmittedSources);

    dirtyAnswerKeysRef.current = new Set();
  }, [experimentItemId, initialFollowUpRecords]);

  useEffect(() => {
    answersBySourceRef.current = answersBySource;
  }, [answersBySource]);

  useEffect(() => {
    questionIdsBySourceRef.current = questionIdsBySource;
  }, [questionIdsBySource]);

  useEffect(() => {
    generatedResultsRef.current = generatedResults;
  }, [generatedResults]);

  const visibleCausalItems = useMemo(() => {
    if (includeImplicit) {
      return initialCausalItems.filter((item) => item.explicit_type.trim().toUpperCase() === "I");
    }

    return initialCausalItems;
  }, [includeImplicit, initialCausalItems]);

  const generatedBySourceText = useMemo(() => {
    return new Map(generatedResults.map((result) => [result.source_text, result]));
  }, [generatedResults]);

  const ensureExperimentItemId = (): string => {
    const itemId = (experimentItemId || "").trim();
    if (!itemId) {
      throw new Error("No selected causal source item. Open follow-up from an extracted source file.");
    }

    return itemId;
  };

  const reloadFollowUpRecords = async (itemId: string): Promise<FollowUpRecord[]> => {
    const records = await loadFollowUpRecordsForItem(itemId);
    const hydratedResults = toGeneratedResults(records);
    const serverAnswers = toAnswersMap(records);
    const localDraft = readFollowUpDraftFromStorage(itemId);
    setGeneratedResults(hydratedResults);
    setQuestionIdsBySource(toQuestionIdMap(records));
    const mergedAnswers = mergeAnswersByPriority(serverAnswers, localDraft?.answersBySource ?? {});
    setAnswersBySource(mergedAnswers);
    setFilterBasisAnswersBySource(mergedAnswers);
    setDerivedExtractionBySourceQuestion(toDerivedExtractionMap(records));
    return records;
  };

  const refreshFilterSnapshot = () => {
    setFilterBasisAnswersBySource(answersBySourceRef.current);
  };

  const handleFilterModeChange = (mode: AnswerFilterMode) => {
    setAnswerFilterMode(mode);
    refreshFilterSnapshot();
  };

  const flushDraftAnswersToDatabase = async (reason: "threshold" | "blur" | "leave" | "submit") => {
    const itemId = (experimentItemId || "").trim();
    if (!itemId) {
      return;
    }

    if (isDraftSyncInFlightRef.current) {
      shouldDraftSyncAgainRef.current = true;
      return;
    }

    const dirtyKeys = Array.from(dirtyAnswerKeysRef.current);
    if (dirtyKeys.length === 0) {
      return;
    }

    isDraftSyncInFlightRef.current = true;

    try {
      const currentAnswers = answersBySourceRef.current;
      const currentQuestionIds = questionIdsBySourceRef.current;
      const sourceToQuestionSet = new Map<string, Set<string>>();

      for (const key of dirtyKeys) {
        const separator = key.indexOf("||");
        if (separator <= 0) {
          continue;
        }

        const sourceText = key.slice(0, separator);
        const question = key.slice(separator + 2);
        const sourceSet = sourceToQuestionSet.get(sourceText) ?? new Set<string>();
        sourceSet.add(question);
        sourceToQuestionSet.set(sourceText, sourceSet);
      }

      const answersPayload: Array<{ questionId: string; answerText: string; answeredBy: string }> = [];

      for (const [sourceText, questionSet] of sourceToQuestionSet.entries()) {
        const sourceAnswers = currentAnswers[sourceText] ?? {};
        const questions = Array.from(questionSet);
        if (questions.length === 0) {
          continue;
        }

        const allSourceQuestions = generatedResultsRef.current.find((item) => item.source_text === sourceText)?.generated_questions ?? questions;
        let sourceQuestionIds = currentQuestionIds[sourceText] ?? {};
        const hasMissing = allSourceQuestions.some((question) => !(sourceQuestionIds[question] ?? "").trim());
        if (hasMissing) {
          sourceQuestionIds = await ensureQuestionIdsForSource(itemId, sourceText, allSourceQuestions);
        }

        for (const question of questions) {
          const answerText = (sourceAnswers[question] ?? "").trim();
          const questionId = (sourceQuestionIds[question] ?? "").trim();
          if (!questionId) {
            continue;
          }

          answersPayload.push({
            questionId,
            answerText,
            answeredBy: "user",
          });
        }
      }

      if (answersPayload.length > 0) {
        await saveFollowUpAnswersForItem({
          experimentItemId: itemId,
          answers: answersPayload,
        });
      }

      dirtyAnswerKeysRef.current = new Set();
      if (reason !== "submit") {
        setDraftSyncStatus(`Draft synced (${String(answersPayload.length)} answer(s)).`);
      }
    } catch {
      if (reason !== "submit") {
        setDraftSyncStatus("Draft saved locally. Server sync will retry automatically.");
      }
    } finally {
      isDraftSyncInFlightRef.current = false;
      if (shouldDraftSyncAgainRef.current) {
        shouldDraftSyncAgainRef.current = false;
        void flushDraftAnswersToDatabase("threshold");
      }
    }
  };

  const scheduleDraftSync = () => {
    if (draftDebounceTimerRef.current !== null) {
      window.clearTimeout(draftDebounceTimerRef.current);
    }

    draftDebounceTimerRef.current = window.setTimeout(() => {
      draftDebounceTimerRef.current = null;
      void flushDraftAnswersToDatabase("threshold");
    }, DRAFT_SYNC_DEBOUNCE_MS);
  };

  const flushDraftNow = (reason: "blur" | "leave" | "submit") => {
    if (draftDebounceTimerRef.current !== null) {
      window.clearTimeout(draftDebounceTimerRef.current);
      draftDebounceTimerRef.current = null;
    }

    void flushDraftAnswersToDatabase(reason);
  };

  flushDraftNowRef.current = flushDraftNow;

  useEffect(() => {
    const itemId = (experimentItemId || "").trim();
    if (!itemId) {
      return;
    }

    writeFollowUpDraftToStorage(itemId, answersBySource);
  }, [answersBySource, experimentItemId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleBeforeUnload = () => {
      const itemId = (experimentItemId || "").trim();
      if (itemId) {
        writeFollowUpDraftToStorage(itemId, answersBySourceRef.current);
      }
      flushDraftNowRef.current("leave");
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      flushDraftNowRef.current("leave");
    };
  }, [experimentItemId]);

  const handleNewQuestionDraftChange = (sourceText: string, value: string) => {
    setNewQuestionDraftBySource((previous) => ({
      ...previous,
      [sourceText]: value,
    }));
  };

  const handleAddQuestionSet = (sourceText: string) => {
    const nextQuestion = (newQuestionDraftBySource[sourceText] ?? "").trim();
    if (!nextQuestion) {
      return;
    }

    const existingQuestions = generatedBySourceText.get(sourceText)?.generated_questions ?? [];
    const isDuplicate = existingQuestions.some(
      (question) => question.trim().toLowerCase() === nextQuestion.toLowerCase(),
    );

    if (isDuplicate) {
      setGenerationStatus("This question already exists in the current set.");
      return;
    }

    setGeneratedResults((previous) => {
      const bySource = new Map(previous.map((result) => [result.source_text, result]));
      const current = bySource.get(sourceText);
      if (current) {
        bySource.set(sourceText, {
          ...current,
          generated_questions: [...current.generated_questions, nextQuestion],
        });
      } else {
        const sourceCausal = initialCausalItems.find((item) => item.source_text === sourceText);
        bySource.set(sourceText, {
          source_text: sourceText,
          sentence_type: sourceCausal?.sentence_type ?? "",
          generated_questions: [nextQuestion],
        });
      }

      return visibleCausalItems
        .map((item) => bySource.get(item.source_text))
        .filter((item): item is GeneratedQuestionsData => Boolean(item));
    });

    setAnswersBySource((previous) => ({
      ...previous,
      [sourceText]: {
        ...(previous[sourceText] ?? {}),
        [nextQuestion]: previous[sourceText]?.[nextQuestion] ?? "",
      },
    }));

    setNewQuestionDraftBySource((previous) => ({
      ...previous,
      [sourceText]: "",
    }));

    setOpenedPanels((previous) => {
      const next = new Set(previous);
      next.add(sourceText);
      return next;
    });

    setGroupSubmitStatus((previous) => ({
      ...previous,
      [sourceText]: "",
    }));
    setGenerationStatus("Added a new question and answer box. Fill the answer, then submit.");
  };

  const handleGenerateAllQuestions = async () => {
    if (visibleCausalItems.length === 0) {
      setGenerationStatus("No causal items are currently displayed.");
      return;
    }

    setIsGeneratingAll(true);
    setGenerationStatus("");

    try {
      const itemId = ensureExperimentItemId();
      const generatedRows = await requestGeneratedQuestions(visibleCausalItems, model);
      const generatedBySource = new Map(generatedRows.map((row) => [row.source_text, row]));

      await saveFollowUpQuestionsForItem({
        experimentItemId: itemId,
        records: visibleCausalItems.map((item) => ({
          sourceText: item.source_text,
          sentenceType: item.sentence_type,
          generatedQuestions: generatedBySource.get(item.source_text)?.generated_questions ?? [],
          causalRef: toCausalRef(item),
          generatedBy: "system",
        })),
      });

      await reloadFollowUpRecords(itemId);
      setOpenedPanels(new Set(visibleCausalItems.map((item) => item.source_text)));
      setGroupSubmitStatus({});
      setAllSubmitStatus("");
      setGenerationStatus(`Generated follow-up questions for ${String(visibleCausalItems.length)} displayed causal item(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate follow-up questions.";
      setGenerationStatus(message);
    } finally {
      setIsGeneratingAll(false);
    }
  };

  const handleGenerateForCausal = async (causal: CausalItem) => {
    setGeneratingSources((previous) => {
      const next = new Set(previous);
      next.add(causal.source_text);
      return next;
    });
    setGenerationStatus("");

    try {
      const itemId = ensureExperimentItemId();
      const generatedRows = await requestGeneratedQuestions([causal], model);
      const generated = generatedRows.find((row) => row.source_text === causal.source_text);

      await saveFollowUpQuestionsForItem({
        experimentItemId: itemId,
        records: [
          {
            sourceText: causal.source_text,
            sentenceType: causal.sentence_type,
            generatedQuestions: generated?.generated_questions ?? [],
            causalRef: toCausalRef(causal),
            generatedBy: "system",
          },
        ],
      });

      await reloadFollowUpRecords(itemId);
      setOpenedPanels((previous) => {
        const next = new Set(previous);
        next.add(causal.source_text);
        return next;
      });

      if ((generated?.generated_questions.length ?? 0) === 0) {
        setGenerationStatus("No follow-up questions were generated for this causal item.");
      } else {
        setGenerationStatus(`Generated ${String(generated?.generated_questions.length ?? 0)} question(s) for selected causal.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate follow-up questions.";
      setGenerationStatus(message);
    } finally {
      setGeneratingSources((previous) => {
        const next = new Set(previous);
        next.delete(causal.source_text);
        return next;
      });
    }
  };

  const handleAnswerChange = (sourceText: string, question: string, answer: string) => {
    setAnswersBySource((previous) => ({
      ...previous,
      [sourceText]: {
        ...(previous[sourceText] ?? {}),
        [question]: answer,
      },
    }));

    dirtyAnswerKeysRef.current.add(`${sourceText}||${question}`);
    setDraftSyncStatus("Saving draft...");

    if (dirtyAnswerKeysRef.current.size >= DRAFT_SYNC_THRESHOLD) {
      flushDraftNow("blur");
      return;
    }

    scheduleDraftSync();
  };

  const handleAnswerBlur = () => {
    flushDraftNow("blur");
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

    let removedCount = 0;
    let keptCount = 0;

    const filtered = generatedResults.map((result) => {
      const keptQuestions = result.generated_questions.filter((question) => {
        const shouldFilterOut = isLikelyInternetAnswerable(question);
        if (shouldFilterOut) {
          removedCount += 1;
          return false;
        }
        keptCount += 1;
        return true;
      });

      return {
        ...result,
        generated_questions: keptQuestions,
      };
    });

    setGeneratedResults(filtered);
    setGenerationStatus(`Filter completed: removed ${String(removedCount)} internet-answerable question(s), kept ${String(keptCount)} context-specific question(s).`);
    setIsFiltering(false);
  };

  const ensureQuestionIdsForSource = async (
    itemId: string,
    sourceText: string,
    questions: string[],
  ): Promise<Record<string, string>> => {
    const currentIds = questionIdsBySourceRef.current[sourceText] ?? {};
    const hasMissingIds = questions.some((question) => !(currentIds[question] ?? "").trim());
    if (!hasMissingIds) {
      return currentIds;
    }

    const sourceCausal = initialCausalItems.find((item) => item.source_text === sourceText);
    if (!sourceCausal) {
      throw new Error("Unable to map this causal source when saving custom questions.");
    }

    await saveFollowUpQuestionsForItem({
      experimentItemId: itemId,
      records: [
        {
          sourceText,
          sentenceType: sourceCausal.sentence_type,
          generatedQuestions: questions,
          causalRef: toCausalRef(sourceCausal),
          generatedBy: "user",
        },
      ],
    });

    const records = await reloadFollowUpRecords(itemId);
    const refreshedIds = toQuestionIdMap(records)[sourceText] ?? {};
    return refreshedIds;
  };

  const handleSubmitGroup = async (sourceText: string, questions: string[]) => {
    if (questions.length === 0) {
      setGroupSubmitStatus((previous) => ({
        ...previous,
        [sourceText]: "No generated questions to submit for this causal.",
      }));
      return;
    }

    const answers = answersBySource[sourceText] ?? {};
    const answeredQuestions = questions.filter((question) => (answers[question] ?? "").trim().length > 0);
    const unansweredCount = questions.length - answeredQuestions.length;

    if (answeredQuestions.length === 0) {
      setGroupSubmitStatus((previous) => ({
        ...previous,
        [sourceText]: "No answered questions in this group yet. Draft is saved automatically.",
      }));
      return;
    }

    try {
      flushDraftNow("submit");
      const itemId = ensureExperimentItemId();
      const questionIds = await ensureQuestionIdsForSource(itemId, sourceText, questions);
      const unresolvedCount = answeredQuestions.filter((question) => !(questionIds[question] ?? "").trim()).length;
      if (unresolvedCount > 0) {
        setGroupSubmitStatus((previous) => ({
          ...previous,
          [sourceText]: "Unable to map one or more questions to database records.",
        }));
        return;
      }

      const submitResult = await submitFollowUpAnswersWithReextract({
        experimentItemId: itemId,
        model,
        answers: answeredQuestions.map((question) => ({
          questionId: questionIds[question],
          questionText: question,
          sourceText,
          answerText: (answers[question] ?? "").trim(),
          answeredBy: "user",
        })),
      });

      await reloadFollowUpRecords(itemId);

      for (const question of answeredQuestions) {
        dirtyAnswerKeysRef.current.delete(`${sourceText}||${question}`);
      }

      setSubmittedSources((previous) => {
        const next = new Set(previous);
        next.add(sourceText);
        return next;
      });

      setGroupSubmitStatus((previous) => ({
        ...previous,
        [sourceText]: `Submitted ${String(answeredQuestions.length)} answered item(s), re-extracted ${String(submitResult.extractedFromFollowUp)} follow-up Q&A pair(s). Skipped ${String(unansweredCount)} unanswered item(s).`,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to submit this Q&A group.";
      setGroupSubmitStatus((previous) => ({
        ...previous,
        [sourceText]: message,
      }));
    }
  };

  const handleSubmitAllQA = async () => {
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

    const answeredPairs = qaPairs.filter(({ sourceText, question }) => {
      const answer = answersBySource[sourceText]?.[question] ?? "";
      return answer.trim().length > 0;
    });

    if (answeredPairs.length === 0) {
      setAllSubmitStatus("No answered questions yet. Draft answers are being saved automatically.");
      return;
    }

    try {
      flushDraftNow("submit");
      const itemId = ensureExperimentItemId();
      const sourceToQuestions = new Map<string, string[]>();
      for (const pair of answeredPairs) {
        const current = sourceToQuestions.get(pair.sourceText) ?? [];
        current.push(pair.question);
        sourceToQuestions.set(pair.sourceText, current);
      }

      const resolvedIdsBySource: Record<string, Record<string, string>> = {};
      for (const [sourceText, questions] of sourceToQuestions.entries()) {
        resolvedIdsBySource[sourceText] = await ensureQuestionIdsForSource(itemId, sourceText, questions);
      }

      const answersPayload = answeredPairs
      .map(({ sourceText, question }) => {
        const questionId = resolvedIdsBySource[sourceText]?.[question] ?? "";
        return {
          questionId,
          questionText: question,
          sourceText,
          answerText: (answersBySource[sourceText]?.[question] ?? "").trim(),
          answeredBy: "user",
        };
      })
      .filter((entry) => entry.questionId.trim().length > 0);

      if (answersPayload.length !== answeredPairs.length) {
        setAllSubmitStatus("Some questions are not mapped to database records yet. Please review and try again.");
        return;
      }

      const submitResult = await submitFollowUpAnswersWithReextract({
        experimentItemId: itemId,
        model,
        answers: answersPayload,
      });

      await reloadFollowUpRecords(itemId);

      for (const pair of answeredPairs) {
        dirtyAnswerKeysRef.current.delete(`${pair.sourceText}||${pair.question}`);
      }

      setSubmittedSources((previous) => {
        const next = new Set(previous);
        for (const pair of answeredPairs) {
          next.add(pair.sourceText);
        }
        return next;
      });

      setAllSubmitStatus(
        `Submitted ${String(answeredPairs.length)} answered item(s), re-extracted ${String(submitResult.extractedFromFollowUp)} follow-up Q&A pair(s). Skipped ${String(unansweredCount)} unanswered item(s).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to submit all Q&A.";
      setAllSubmitStatus(message);
    }
  };

  const answerCounts = useMemo(() => {
    let answered = 0;
    let unanswered = 0;

    for (const result of generatedResults) {
      const sourceAnswers = filterBasisAnswersBySource[result.source_text] ?? {};
      for (const question of result.generated_questions) {
        if ((sourceAnswers[question] ?? "").trim()) {
          answered += 1;
        } else {
          unanswered += 1;
        }
      }
    }

    return { answered, unanswered };
  }, [filterBasisAnswersBySource, generatedResults]);

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 backdrop-blur-sm md:p-6">
      <header className="mx-auto mb-6 max-w-3xl text-center">
        <h2 className="text-xl font-bold text-neutral-100 md:text-2xl">Follow-up question section</h2>
        <p className="mt-2 text-sm text-neutral-300">
          You can generate follow-up questions for implicit information based on your input, and the engine will
          generate analytical questions for you to obtain more useful information and accuracy. (This part is optional)
        </p>
      </header>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleGenerateAllQuestions()}
            disabled={isGeneratingAll}
            className="rounded-lg border border-emerald-500 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:border-neutral-700 disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {isGeneratingAll ? "Generating..." : "Generate all questions"}
          </button>

          <button
            type="button"
            onClick={handleRunFilter}
            disabled={isFiltering || !hasGenerated || generatedResults.length === 0}
            title="Filter out questions that can be answered on the internet."
            aria-label="Filter out questions that can be answered on the internet"
            className="rounded-lg border border-sky-500 bg-sky-500/20 px-4 py-2 text-sm font-bold text-sky-200 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:border-neutral-700 disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {isFiltering ? "RUNNING FILTER..." : "Run filter"}
          </button>

          <div className="inline-flex overflow-hidden rounded-lg border border-neutral-700">
            <button
              type="button"
              onClick={() => handleFilterModeChange("all")}
              className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                answerFilterMode === "all"
                  ? "bg-sky-500/25 text-sky-200"
                  : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              All ({String(answerCounts.answered + answerCounts.unanswered)})
            </button>
            <button
              type="button"
              onClick={() => handleFilterModeChange("unanswered")}
              className={`border-l border-neutral-700 px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                answerFilterMode === "unanswered"
                  ? "bg-amber-500/25 text-amber-200"
                  : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              Unanswered ({String(answerCounts.unanswered)})
            </button>
            <button
              type="button"
              onClick={() => handleFilterModeChange("answered")}
              className={`border-l border-neutral-700 px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                answerFilterMode === "answered"
                  ? "bg-emerald-500/25 text-emerald-200"
                  : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              Answered ({String(answerCounts.answered)})
            </button>
          </div>

          <button
            type="button"
            onClick={refreshFilterSnapshot}
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-200 transition hover:bg-neutral-800"
            title="Refresh answered/unanswered grouping from current edits"
          >
            Update filter view
          </button>
        </div>

        <button
          type="button"
          onClick={() => void handleSubmitAllQA()}
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-5 py-2 text-sm font-bold tracking-wide text-neutral-100 transition hover:border-neutral-500"
        >
          Submit all answered Question & Answer
        </button>
      </div>

      <div className="mt-3 rounded-lg border border-amber-700/50 bg-amber-500/10 p-3 text-xs text-amber-100">
        For better performance and reliability, submit in batches (for example one causal group at a time). You can continue drafting unanswered items and submit them later.
      </div>

      <p className="mt-2 text-xs text-neutral-400">
        Run filter will filter out questions that can be answered on the internet.
      </p>

      {generationStatus ? <p className="mt-3 text-sm text-neutral-300">{generationStatus}</p> : null}
      {draftSyncStatus ? <p className="mt-2 text-xs text-neutral-400">{draftSyncStatus}</p> : null}
      {allSubmitStatus ? <p className="mt-3 text-sm text-neutral-300">{allSubmitStatus}</p> : null}

      <div>
        <div>
          <p className="mb-3 text-sm font-semibold text-neutral-200">Select implicit causal for question generation</p>
          <div className="space-y-3">
            {visibleCausalItems.map((causal, index) => {
              const generated = generatedBySourceText.get(causal.source_text);
              const sourceQuestions = generated?.generated_questions ?? [];
              const sourceAnswers = answersBySource[causal.source_text] ?? {};
              const sourceFilterAnswers = filterBasisAnswersBySource[causal.source_text] ?? {};
              const sourceAnsweredCount = sourceQuestions.filter((question) => (sourceFilterAnswers[question] ?? "").trim().length > 0).length;
              const sourceUnansweredCount = sourceQuestions.length - sourceAnsweredCount;

              return (
                <CausalCard
                  key={causal.source_text}
                  causal={causal}
                  index={index}
                  generatedQuestions={sourceQuestions}
                  isPanelOpen={openedPanels.has(causal.source_text)}
                  onTogglePanel={() => toggleGeneratedPanel(causal.source_text)}
                  onGenerateForCausal={() => void handleGenerateForCausal(causal)}
                  isGeneratingForCausal={generatingSources.has(causal.source_text)}
                  answers={sourceAnswers}
                  filterAnswers={sourceFilterAnswers}
                  onAnswerChange={(question, answer) => handleAnswerChange(causal.source_text, question, answer)}
                  onAnswerBlur={handleAnswerBlur}
                  newQuestionDraft={newQuestionDraftBySource[causal.source_text] ?? ""}
                  onNewQuestionDraftChange={(value) => handleNewQuestionDraftChange(causal.source_text, value)}
                  onAddQuestionSet={() => handleAddQuestionSet(causal.source_text)}
                  onSubmitGroup={() => void handleSubmitGroup(causal.source_text, sourceQuestions)}
                  groupSubmitMessage={groupSubmitStatus[causal.source_text] ?? ""}
                  derivedExtractionByQuestion={derivedExtractionBySourceQuestion[causal.source_text] ?? {}}
                  answerFilterMode={answerFilterMode}
                  totalAnsweredCount={sourceAnsweredCount}
                  totalUnansweredCount={sourceUnansweredCount}
                  isAddedToCausalStructure={
                    submittedSources.has(causal.source_text) ||
                    Object.keys(derivedExtractionBySourceQuestion[causal.source_text] ?? {}).length > 0
                  }
                />
              );
            })}

            {includeImplicit && visibleCausalItems.length === 0 ? (
              <p className="rounded-lg border border-neutral-700 bg-neutral-950/80 p-3 text-sm text-neutral-300">
                No implicit causal items (explicit_type = I) found for question generation.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
