
import Link from "next/link";

type BackToHomeProps = {
  href?: string;
  label?: string;
  className?: string;
  containerClassName?: string;
};

export default function BackToHome({
  href = "/",
  label = "Back to dashboard",
  className = "",
  containerClassName = "mt-6",
}: BackToHomeProps) {
  return (
    <div className={containerClassName}>
      <Link
        href={href}
        className={`inline-flex items-center rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:border-sky-500 hover:text-sky-200 ${className}`.trim()}
      >
        {label}
      </Link>
    </div>
  );
}