"use client";

import { useId, useMemo } from "react";

type ModelPickerProps = {
  value: string;
  onChange: (model: string) => void;
  label?: string;
  placeholder?: string;
  containerClassName?: string;
  inputClassName?: string;
  additionalOptions?: string[];
};

const GEMINI_MODEL_FALLBACK_OPTIONS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-pro-preview",
];

function dedupeModelNames(names: string[]): string[] {
  return Array.from(new Set(names.filter(Boolean)));
}

export default function ModelPicker({
  value,
  onChange,
  label = "model",
  placeholder = "default from .env",
  containerClassName,
  inputClassName,
  additionalOptions = [],
}: ModelPickerProps) {
  const listId = useId();

  const modelOptions = useMemo(() => {
    const envOptions = [
      process.env.NEXT_PUBLIC_GEMINI_MODEL_OPTIONS || "",
      process.env.NEXT_PUBLIC_CAUSAL_EXTRACT_MODEL_OPTIONS || "",
      process.env.NEXT_PUBLIC_MAP_EXTRACT_MODEL_OPTIONS || "",
    ]
      .join(",")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    return dedupeModelNames([...envOptions, ...additionalOptions, ...GEMINI_MODEL_FALLBACK_OPTIONS]);
  }, [additionalOptions]);

  return (
    <div
      className={
        containerClassName ||
        "rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300"
      }
    >
      <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">{label}</div>
      <input
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={
          inputClassName ||
          "w-52 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-100 outline-none transition focus:border-sky-500"
        }
      />
      <datalist id={listId}>
        {modelOptions.map((modelName) => (
          <option key={modelName} value={modelName} />
        ))}
      </datalist>
    </div>
  );
}
