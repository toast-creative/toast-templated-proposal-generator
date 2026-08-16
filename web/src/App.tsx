import { LogOut, Moon, Sun } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useHarnessSocket } from "./useHarnessSocket";
import { useTheme } from "./useTheme";
import { useAuth } from "./useAuth";
import { Login } from "./components/Login";
import { TaskPane } from "./components/TaskPane";
import { RightPane } from "./components/RightPane";

export function App() {
  const { authed, login, logout } = useAuth();
  const { events, connected, send } = useHarnessSocket(authed);
  const { theme, toggle } = useTheme();

  if (!authed) {
    return (
      <TooltipProvider delayDuration={300}>
        <Login onSubmit={login} />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-semibold tracking-tight">
            Toast<span className="text-muted-foreground"> Proposal AI MVP</span>
          </span>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs",
                connected ? "text-emerald-600" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-2 rounded-full",
                  connected ? "bg-emerald-500" : "bg-muted-foreground/50",
                )}
              />
              {connected ? "connected" : "disconnected"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={toggle}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={logout}
              aria-label="Log out"
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>
        <main className="grid min-h-0 flex-1 grid-cols-2">
          <TaskPane events={events} send={send} />
          <RightPane events={events} />
        </main>
      </div>
    </TooltipProvider>
  );
}
