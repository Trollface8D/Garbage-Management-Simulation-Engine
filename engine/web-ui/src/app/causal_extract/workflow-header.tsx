import { type ReactNode } from "react";
import BackToHome from "../components/back-to-home";
import ModelPicker from "@/app/components/model-picker";

type ComponentLabelMode = "paragraph" | "inline";

type CausalWorkflowHeaderProps = {
  title: string;
  selectedTitle: string;
  selectedProjectName: string;
  selectedModel: string;
  onSelectedModelChange: (value: string) => void;
  description?: ReactNode;
  titleUppercase?: boolean;
  leftContainerClassName?: string;
  componentLabelMode?: ComponentLabelMode;
  actionsClassName?: string;
};

export default function CausalWorkflowHeader({
  title,
  selectedTitle,
  selectedProjectName,
  selectedModel,
  onSelectedModelChange,
  description,
  titleUppercase = true,
  leftContainerClassName,
  componentLabelMode = "paragraph",
  actionsClassName,
}: CausalWorkflowHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className={leftContainerClassName}>
        <h1 className={`text-3xl font-black tracking-tight md:text-4xl ${titleUppercase ? "uppercase" : ""}`.trim()}>
          {title}
        </h1>

        {description ? <div className="mt-2 text-sm text-neutral-300">{description}</div> : null}

        {componentLabelMode === "paragraph" ? (
          <p className="mt-2 text-sm text-neutral-300">
            Selected component: <span className="font-semibold text-neutral-100">{selectedTitle}</span>
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          {componentLabelMode === "inline" ? (
            <>
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Selected component
              </span>
              <span className="text-sm text-neutral-300">{selectedTitle}</span>
            </>
          ) : null}
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Project</span>
          <span className="text-sm text-neutral-300">{selectedProjectName}</span>
        </div>
      </div>

      <div className={actionsClassName ?? "flex flex-wrap items-center gap-2"}>
        <ModelPicker
          value={selectedModel}
          onChange={onSelectedModelChange}
          containerClassName="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300"
        />
        <BackToHome
          href="/"
          label="Back to project"
          useHistoryBack
          containerClassName=""
          className="rounded-md px-3 py-2"
        />
      </div>
    </header>
  );
}