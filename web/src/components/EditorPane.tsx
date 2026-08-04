import { useEffect, useState } from "react";
import { LayoutTemplate, Loader2 } from "lucide-react";
import type { DetectedTemplate } from "@/lib/template";

// The embed token identifies this app to Templated's editor.
const EMBED_ID = "61d1e0c9-43a3-49a6-b1c2-a5ca7ccd0e51";

function embedUrl(id: string): string {
  return `https://app.templated.io/editor/${id}?embed=${EMBED_ID}`;
}

// Once the agent finishes, the generated template is editable in-place: we drop
// Templated's own editor into an iframe so the user can tweak the proposal
// without leaving the app.
export function EditorPane({ template }: { template: DetectedTemplate | null }) {
  const [loading, setLoading] = useState(true);

  // Show the spinner again whenever we point the iframe at a new template.
  useEffect(() => {
    setLoading(true);
  }, [template?.id]);

  if (!template) {
    return (
      <div className="text-muted-foreground flex h-full min-h-0 flex-col items-center justify-center gap-3 px-8 text-center">
        <LayoutTemplate className="size-8 opacity-30" />
        <p className="max-w-xs text-sm">
          Your editable proposal appears here once the agent finishes building
          the template.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      {loading && (
        <div className="bg-background/70 absolute inset-0 z-10 flex items-center justify-center backdrop-blur-sm">
          <span className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading editor…
          </span>
        </div>
      )}
      <iframe
        key={template.id}
        title="Templated editor"
        src={embedUrl(template.id)}
        className="h-full w-full border-0"
        allow="clipboard-read; clipboard-write; fullscreen"
        onLoad={() => setLoading(false)}
      />
    </div>
  );
}
