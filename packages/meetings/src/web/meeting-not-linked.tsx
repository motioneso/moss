import { Button, EmptyState } from "@moss/ui";

export function MeetingNotLinked() {
  return (
    <EmptyState
      title="Link your Mac"
      description="Open Trail Marker and follow its linking instructions."
    >
      <div className="meetings-download">
        <Button>Download app</Button>
      </div>
    </EmptyState>
  );
}
