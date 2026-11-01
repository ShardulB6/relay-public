import { cn } from "cn";
import { ChevronLeftIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** The header of a view shown in place of the chat: its title, and Done to return to the chat. */
export function PageHeader({
  title,
  close,
  back,
}: {
  title: string;
  close: () => void;
  /** Return to the view this one was opened from. */
  back?: () => void;
}) {
  return (
    <header className={cn("flex items-center justify-between gap-2 border-b p-2", !back && "pl-3")}>
      <div className="flex min-w-0 items-center gap-1">
        {back ? (
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={back}>
            <ChevronLeftIcon />
          </Button>
        ) : null}
        <h1 className="truncate font-heading text-base font-medium">{title}</h1>
      </div>
      <Button variant="outline" size="sm" onClick={close}>
        Done
      </Button>
    </header>
  );
}
