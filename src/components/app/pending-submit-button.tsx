"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "@/components/ui/button";

type PendingSubmitButtonProps = ButtonProps & {
  pendingLabel?: string;
};

export function PendingSubmitButton({
  children,
  disabled,
  pendingLabel = "Working...",
  ...props
}: PendingSubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button disabled={disabled || pending} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
