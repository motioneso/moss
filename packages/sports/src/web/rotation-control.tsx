import { Button } from "@moss/ui";

export function RotationControl(props: {
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        aria-pressed={props.paused}
        disabled={props.reducedMotion}
        onClick={props.onToggle}
      >
        {props.paused ? "Resume rotation" : "Pause rotation"}
      </Button>
      {props.reducedMotion ? <span role="status">Rotation is off for reduced motion.</span> : null}
    </>
  );
}
