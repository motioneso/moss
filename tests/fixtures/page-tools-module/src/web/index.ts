import { Button, h, useState, type ExternalModuleToolsHandleV1 } from "@moss/module-web-sdk";
function Root(props: { tools?: ExternalModuleToolsHandleV1 }) {
  const [checked, setChecked] = useState(false);
  const [status, setStatus] = useState("Ready");
  const run = async (name: string) => {
    setStatus("Working");
    const result = await props.tools?.invoke(`page-tools-proof.${name}`, {});
    setStatus(result?.status ?? "unsupported");
    if (result?.status === "succeeded" && name === "save") setChecked(true);
    if (result?.status === "succeeded" && name === "delete") setChecked(false);
  };
  return h(
    "section",
    { "aria-label": "Installed synthetic module" },
    h(
      "p",
      null,
      "Synthetic records only. This module tests the real host, worker and owner storage."
    ),
    h(
      "label",
      null,
      h("input", {
        type: "checkbox",
        checked,
        disabled: status === "Working" || checked,
        onChange: () => void run("save")
      }),
      "Pack the synthetic tent"
    ),
    h(Button, { onClick: () => void run("delete") }, "Delete synthetic entry"),
    h(Button, { onClick: () => void run("send") }, "Send to synthetic recipient"),
    h("p", { role: "status" }, status)
  );
}
export default { contractVersion: 2, Root };
