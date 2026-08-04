import { CheckCircle2, ChevronRight, ExternalLink } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProposalSummary } from "@/lib/template";

// A structured, scannable result card for a finished proposal — built purely from
// the harness event stream (see extractProposalSummary). It replaces the old wall of
// LLM markdown: a clear headline, stat chips, service tags, one primary action, and
// the noisy per-page slug lists tucked behind a collapsed disclosure.
export function ProposalSummaryCard({ summary }: { summary: ProposalSummary }) {
  const stats: Array<{ label: string; value: number }> = [];
  if (typeof summary.clientCount === "number")
    stats.push({ label: "Clients", value: summary.clientCount });
  if (typeof summary.logoCount === "number")
    stats.push({ label: "Logos", value: summary.logoCount });
  if (summary.story)
    stats.push(
      { label: "Stories", value: summary.story.storiesCreated },
      { label: "Story pages", value: summary.story.pagesCreated },
    );

  const subline = [summary.client, summary.folderName]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="flex items-start gap-2.5">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" />
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {summary.templateName || "Proposal ready"}
          </div>
          {subline && (
            <div className="text-muted-foreground truncate text-xs">
              {subline}
            </div>
          )}
        </div>
      </div>

      {stats.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="bg-background/60 flex items-baseline gap-1.5 rounded-md border px-2.5 py-1"
            >
              <span className="text-sm font-semibold tabular-nums">
                {stat.value}
              </span>
              <span className="text-muted-foreground text-xs">
                {stat.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {summary.serviceFocus && summary.serviceFocus.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {summary.serviceFocus.map((service) => (
            <span
              key={service}
              className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs"
            >
              {service}
            </span>
          ))}
        </div>
      )}

      {summary.story && (
        <Collapsible className="mt-3">
          <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-xs font-medium">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            Story pages ({summary.story.pagesCreated})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-2 pl-5">
            <PageGroup label="Description" pages={summary.story.descriptionPages} />
            <PageGroup label="Masonry" pages={summary.story.masonryPages} />
            <PageGroup label="Full" pages={summary.story.fullPages} />
          </CollapsibleContent>
        </Collapsible>
      )}

      <Button asChild size="sm" className="mt-4 gap-1.5">
        <a href={summary.editableUrl} target="_blank" rel="noreferrer">
          Open in Templated <ExternalLink className="size-3.5" />
        </a>
      </Button>
    </div>
  );
}

function PageGroup({ label, pages }: { label: string; pages: string[] }) {
  if (pages.length === 0) return null;
  return (
    <div>
      <div className={cn("text-xs font-medium")}>
        {label}{" "}
        <span className="text-muted-foreground tabular-nums">
          ({pages.length})
        </span>
      </div>
      <ul className="text-muted-foreground mt-1 space-y-0.5 font-mono text-[11px] leading-tight">
        {pages.map((page) => (
          <li key={page} className="truncate">
            {page}
          </li>
        ))}
      </ul>
    </div>
  );
}
