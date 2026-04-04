
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

type BackToHomeProps = {
  href?: string;
  label?: string;
  className?: string;
  containerClassName?: string;
  useHistoryBack?: boolean;
};

export default function BackToHome({
  href = "/",
  label = "Back to dashboard",
  className = "",
  containerClassName = "mt-6",
  useHistoryBack = false,
}: BackToHomeProps) {
  const router = useRouter();

  const handleHistoryBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }

    router.push(href);
  };

  return (
    <div className={containerClassName}>
      {useHistoryBack ? (
        <button
          type="button"
          onClick={handleHistoryBack}
          className={`inline-flex items-center rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:border-sky-500 hover:text-sky-200 ${className}`.trim()}
        >
          {label}
        </button>
      ) : (
        <Link
          href={href}
          className={`inline-flex items-center rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:border-sky-500 hover:text-sky-200 ${className}`.trim()}
        >
          {label}
        </Link>
      )}
    </div>
  );
}