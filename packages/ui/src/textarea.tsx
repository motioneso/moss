import type { TextareaHTMLAttributes } from "react";
/** Multiline field with shared theme, focus, invalid and disabled states. */
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={["jds-textarea", className].filter(Boolean).join(" ")} {...props} />;
}
