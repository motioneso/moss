import { useState, type ReactNode } from "react";
import { Avatar } from "./avatar.js";

/** A named entity with optional reviewed artwork and a prominent read-only value. */
export function IdentityMetric({
  name,
  value,
  imageSrc,
  detail
}: {
  name: string;
  value: ReactNode;
  imageSrc?: string | null;
  detail?: ReactNode;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return (
    <div className="jds-identity-metric">
      {imageSrc && imageSrc !== failedSrc ? (
        <img
          src={imageSrc}
          alt={`${name} crest`}
          width={48}
          height={48}
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(imageSrc)}
        />
      ) : (
        <Avatar name={name} size="lg" />
      )}
      <span className="jds-identity-metric__name">{name}</span>
      <strong className="jds-identity-metric__value">{value}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}
