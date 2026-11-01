import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A button showing only an icon, named by its tooltip. */
export function IconButton({
  label,
  onClick,
  children,
  className,
  size = "icon-xs",
  side,
  align,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  size?: "icon-xs" | "icon-sm";
} & Pick<ComponentProps<typeof TooltipContent>, "side" | "align">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            aria-label={label}
            className={className}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
