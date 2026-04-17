import { type ReactNode } from "react";

type ProjectPageHeaderProps = {
  title: string;
  projectName: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  projectLabel?: string;
  containerClassName?: string;
  leftContainerClassName?: string;
  titleClassName?: string;
  projectRowClassName?: string;
  projectLabelClassName?: string;
  projectValueClassName?: string;
};

export default function ProjectPageHeader({
  title,
  projectName,
  subtitle,
  actions,
  projectLabel = "Project",
  containerClassName = "mb-6 flex flex-wrap items-center justify-between gap-3",
  leftContainerClassName,
  titleClassName = "text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl",
  projectRowClassName = "mt-3 flex flex-wrap items-center gap-3",
  projectLabelClassName = "text-xs font-semibold uppercase tracking-wide text-neutral-400",
  projectValueClassName = "text-sm text-neutral-300",
}: ProjectPageHeaderProps) {
  return (
    <header className={containerClassName}>
      <div className={leftContainerClassName}>
        <h1 className={titleClassName}>{title}</h1>
        {subtitle ? <div className="mt-2 text-sm text-neutral-300">{subtitle}</div> : null}
        <div className={projectRowClassName}>
          <span className={projectLabelClassName}>{projectLabel}</span>
          <span className={projectValueClassName}>{projectName}</span>
        </div>
      </div>
      {actions ?? null}
    </header>
  );
}