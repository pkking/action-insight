'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** Windowed page list: 1 … (p-1) p (p+1) … N with ellipsis at gaps. */
export function pageWindow(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  const sorted = [...pages]
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * Shared table pagination (all tabs): page-of-total count, prev/next,
 * windowed page-number buttons, and a jump-to-page input. Renders nothing
 * when everything fits on a single page.
 */
export function TablePagination({
  page,
  totalPages,
  totalRows,
  itemLabel,
  onPage,
}: {
  page: number;
  totalPages: number;
  totalRows: number;
  itemLabel: string;
  onPage: (page: number) => void;
}) {
  const [jump, setJump] = useState('');
  if (totalPages <= 1) return null;

  const submitJump = (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number.parseInt(jump, 10);
    if (Number.isFinite(value)) {
      const target = Math.min(Math.max(value, 1), totalPages);
      if (target !== page) onPage(target);
    }
    setJump('');
  };

  const pageButton = (p: number) => (
    <button
      key={p}
      type="button"
      onClick={() => p !== page && onPage(p)}
      aria-current={p === page ? 'page' : undefined}
      className={`min-w-[26px] rounded-md border px-1.5 py-1 text-xs ${
        p === page
          ? 'border-blue-200 bg-blue-100 font-semibold text-blue-700 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-400'
          : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800'
      }`}
    >
      {p}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
      <span className="text-xs text-neutral-500 dark:text-neutral-400">
        Page {page} of {totalPages} · {totalRows} {itemLabel}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
          className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {pageWindow(page, totalPages).map((p, i) =>
          p === '…' ? (
            <span
              key={`ellipsis-${i}`}
              className="px-1 text-xs text-neutral-400 dark:text-neutral-500"
            >
              …
            </span>
          ) : (
            pageButton(p)
          ),
        )}
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
          className="rounded-md border border-neutral-200 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <form onSubmit={submitJump} className="ml-2 flex items-center gap-1">
          <label
            htmlFor="jump-page"
            className="text-xs text-neutral-500 dark:text-neutral-400"
          >
            Jump to
          </label>
          <input
            id="jump-page"
            type="number"
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            placeholder={String(page)}
            className="w-16 rounded-md border border-neutral-200 bg-transparent px-1.5 py-1 text-xs text-neutral-700 outline-none dark:border-neutral-700 dark:text-neutral-300"
          />
          <button
            type="submit"
            className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            Go
          </button>
        </form>
      </div>
    </div>
  );
}
