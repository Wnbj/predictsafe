import type { ReactNode } from "react";
import { GLOSSARY, type GlossaryKey } from "../lib/glossary";

/**
 * A word with its explanation on hover — and on focus, so a tap shows it on a
 * phone, where there is no hover. Pure CSS; nothing to open or close.
 */
export function Term({ k, children }: { k: GlossaryKey; children: ReactNode }) {
  return (
    <span className="term" tabIndex={0} aria-describedby={`term-${k}`}>
      {children}
      <span className="term-tip" role="tooltip" id={`term-${k}`}>
        {GLOSSARY[k]}
      </span>
    </span>
  );
}
