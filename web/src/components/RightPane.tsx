import { useEffect, useState } from "react";
import type { AgentEvent } from "@shared/events";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { findLatestTemplate, isWorkflowRunning } from "@/lib/template";
import { EditorPane } from "./EditorPane";
import { InspectorPane } from "./InspectorPane";

type Tab = "editor" | "events";

// The right column is two views over the same event stream: the live editor for
// the generated template, and the raw harness event log. They share one header
// row so only the active view's context/actions are shown.
export function RightPane({ events }: { events: AgentEvent[] }) {
  // Only reveal the editor once the whole workflow has finished — the template
  // isn't done being built until then.
  const template = isWorkflowRunning(events) ? null : findLatestTemplate(events);
  const [tab, setTab] = useState<Tab>("events");
  const [surfacedId, setSurfacedId] = useState<string | null>(null);

  // When a finished template lands, surface it: auto-switch to the editor once.
  useEffect(() => {
    if (template && template.id !== surfacedId) {
      setTab("editor");
      setSurfacedId(template.id);
    }
  }, [template, surfacedId]);

  return (
    <section className="flex h-full min-h-0 flex-col border-l">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <TabButton active={tab === "editor"} onClick={() => setTab("editor")}>
            Editor
            {template && (
              <span className="ml-1.5 inline-block size-1.5 rounded-full bg-emerald-500" />
            )}
          </TabButton>
          <TabButton active={tab === "events"} onClick={() => setTab("events")}>
            Events
            <span className="text-muted-foreground ml-1.5 tabular-nums">
              {events.length}
            </span>
          </TabButton>
        </div>

        {tab === "editor" && template && (
          <div className="flex min-w-0 items-center gap-2 pr-1">
            <span className="text-muted-foreground hidden truncate font-mono text-xs sm:inline">
              {template.id}
            </span>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 text-xs"
            >
              <a
                href={template.editableUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open in Templated <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {tab === "editor" ? (
          <EditorPane template={template} />
        ) : (
          <InspectorPane events={events} />
        )}
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
