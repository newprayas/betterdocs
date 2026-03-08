import React from "react";

interface SessionPreparationOverlayProps {
  progress: number;
  title?: string;
  description?: string;
  status?: string;
}

export const SessionPreparationOverlay: React.FC<
  SessionPreparationOverlayProps
> = ({
  progress,
  title = "Preparing books for chat...",
  description = "Loading your sources and getting everything ready.",
  status = "Preparing books",
}) => {
  const clampedProgress = Math.max(0, Math.min(100, progress));

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/96 px-6">
      <div className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/95 p-8 shadow-2xl shadow-slate-950/60">
        <div className="mb-6 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600 shadow-lg shadow-blue-500/20">
            <svg
              className="h-8 w-8 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V6H6.5A2.5 2.5 0 004 8.5v11zM8 7h8"
              />
            </svg>
          </div>
        </div>

        <div className="space-y-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-white">
            {title}
          </h2>
          <p className="text-sm leading-6 text-slate-400">{description}</p>
        </div>

        <div className="mt-8 space-y-3">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-300 ease-out"
              style={{ width: `${clampedProgress}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>{status}</span>
            <span>{Math.round(clampedProgress)}%</span>
          </div>
        </div>
      </div>
    </div>
  );
};
