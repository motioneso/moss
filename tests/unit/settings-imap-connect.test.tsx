// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { getImapPreset } from "@moss/connectors/presets";
import {
  IMAP_PROVIDER_EMAIL_DOMAINS,
  emailDomain,
  findImapProviderIdForEmail,
  imapConnectRequestSchema
} from "@moss/shared";
import { IMAP_PROVIDERS } from "../../apps/web/src/onboarding/google-connector-step.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";
import {
  GENERIC_PASSWORD_HINT,
  GENERIC_SERVER_HINT,
  ImapConnect
} from "../../apps/web/src/settings/settings-imap-connect.js";

vi.mock("../../apps/web/src/api/client.js", () => ({
  connectImapConnection: vi.fn(),
  testImapConnection: vi.fn()
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderFlow(): ReactTestRenderer {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(
        FeedbackProvider,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(ImapConnect, { onBack: () => undefined })
        )
      )
    );
  });
  return renderer;
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}

function typeEmail(renderer: ReactTestRenderer, value: string): void {
  const input = renderer.root.find(
    (node) => node.type === "input" && node.props["aria-label"] === "Email address"
  );
  act(() => {
    input.props.onChange({ target: { value } });
  });
}

function hint(renderer: ReactTestRenderer, which: "server" | "password"): string {
  return textOf(renderer.root.find((node) => node.props["data-hint"] === which));
}

function selectedService(renderer: ReactTestRenderer): string {
  return renderer.root.find((node) => node.type === "select").props.value as string;
}

describe("email-domain lookup", () => {
  it("maps known domains to their provider preset, ignoring case and whitespace", () => {
    expect(findImapProviderIdForEmail("Someone@Yahoo.com ")).toBe("imap-yahoo");
    expect(findImapProviderIdForEmail("a@pm.me")).toBe("imap-proton");
    expect(findImapProviderIdForEmail("a@me.com")).toBe("imap-icloud");
    expect(findImapProviderIdForEmail("a@fastmail.fm")).toBe("imap-fastmail");
  });

  it("returns null for unknown domains and incomplete addresses", () => {
    expect(findImapProviderIdForEmail("a@example.org")).toBeNull();
    expect(findImapProviderIdForEmail("a@")).toBeNull();
    expect(findImapProviderIdForEmail("yahoo.com")).toBeNull();
    expect(emailDomain("nobody")).toBeNull();
  });

  it("only names provider ids the connect API accepts", () => {
    const accepted = imapConnectRequestSchema.properties.providerId.enum as readonly string[];
    for (const id of Object.keys(IMAP_PROVIDER_EMAIL_DOMAINS)) expect(accepted).toContain(id);
  });
});

describe("web provider list stays in step with the backend presets", () => {
  it("shows the same host, port and TLS the server will use", () => {
    for (const provider of IMAP_PROVIDERS) {
      const preset = getImapPreset(provider.id);
      expect(preset, provider.id).toBeDefined();
      expect(provider.server).toEqual({
        host: preset?.imapHost,
        port: preset?.imapPort,
        tls: preset?.imapTls
      });
    }
  });
});

describe("ImapConnect (settings)", () => {
  it("starts as one 'Add an email account' form with generic hints and no service chosen", () => {
    const renderer = renderFlow();
    expect(textOf(renderer.root)).toContain("Add an email account");
    expect(renderer.root.findAll((node) => node.props.className === "onb-provgrid")).toHaveLength(
      0
    );
    expect(selectedService(renderer)).toBe("");
    expect(hint(renderer, "server")).toBe(GENERIC_SERVER_HINT);
    expect(hint(renderer, "password")).toBe(GENERIC_PASSWORD_HINT);
  });

  it("typing a known provider email prefills the server settings and shows its instructions", () => {
    const renderer = renderFlow();
    typeEmail(renderer, "someone@yahoo.com");

    expect(selectedService(renderer)).toBe("imap-yahoo");
    const server = hint(renderer, "server");
    expect(server).toContain("Recognised from your email address");
    expect(server).toContain("imap.mail.yahoo.com, port 993 (encrypted)");

    const password = hint(renderer, "password");
    expect(password).toContain("Generate an app password in Yahoo Account Security");
    expect(password).toContain('select "Create app password."');
    expect(password).toContain("Yahoo Mail setup guide");
    const link = renderer.root.find((node) => node.type === "a");
    expect(link.props.href).toBe("https://help.yahoo.com/kb/SLN15241.html");
  });

  it("an unknown domain keeps the generic service picker and neutral hints", () => {
    const renderer = renderFlow();
    typeEmail(renderer, "someone@example.org");

    expect(selectedService(renderer)).toBe("");
    expect(hint(renderer, "server")).toBe(GENERIC_SERVER_HINT);
    expect(hint(renderer, "password")).toBe(GENERIC_PASSWORD_HINT);
    expect(renderer.root.findAll((node) => node.type === "option")).toHaveLength(
      IMAP_PROVIDERS.length + 1
    );
  });

  it("a hand-picked service wins over the address, and Proton says the server is a local Bridge", () => {
    const renderer = renderFlow();
    typeEmail(renderer, "someone@yahoo.com");
    const select = renderer.root.find((node) => node.type === "select");
    act(() => {
      select.props.onChange({ target: { value: "imap-proton" } });
    });

    expect(selectedService(renderer)).toBe("imap-proton");
    expect(hint(renderer, "server")).not.toContain("Recognised");
    expect(hint(renderer, "server")).toContain(
      "127.0.0.1, port 1143 (no encryption, local Bridge only)"
    );
    expect(hint(renderer, "password")).toContain("Proton Mail Bridge");
  });
});
