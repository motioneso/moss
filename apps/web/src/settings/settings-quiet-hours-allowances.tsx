import { useQuery } from "@tanstack/react-query";
import { Button } from "@moss/ui";
import { listQuietHoursAllowances } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useChatControls } from "../shell/chat-controls-context";
import { Group, Note, Row } from "./settings-ui";

export function QuietHoursAllowances() {
  const query = useQuery({
    queryKey: queryKeys.chat.quietHoursAllowances,
    queryFn: listQuietHoursAllowances,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always"
  });
  const { openChat, openChatThread } = useChatControls();
  const changeInChat = () => {
    if (query.data?.mainThreadId) openChatThread(query.data.mainThreadId);
    else openChat();
  };
  return (
    <Group
      title="Allowed during quiet hours"
      desc="Module mutes and device delivery controls still apply."
    >
      {query.isPending ? <p role="status">Loading allowed tasks...</p> : null}
      {query.isError ? (
        <Note>
          Could not load allowed tasks. Your saved choices have not changed.{" "}
          <Button variant="link" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </Note>
      ) : null}
      {query.data?.allowances.length === 0 ? (
        <p role="status">No tasks are allowed during quiet hours.</p>
      ) : null}
      {query.data?.allowances.map((task) => (
        <Row key={task.id} name={task.title} />
      ))}
      <Button variant="link" size="sm" onClick={changeInChat}>
        Change in chat
      </Button>
    </Group>
  );
}
