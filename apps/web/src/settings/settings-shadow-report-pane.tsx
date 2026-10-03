import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { EmptyState } from "@moss/ui";
import type { ClassifierShadowReportRange } from "@moss/shared";

import { getClassifierShadowReport } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { formatDate, formatTime, useUserLocale } from "../locale/locale-format.js";
import type { PaneProps } from "./settings-types.js";
import { readError } from "./settings-types.js";
import { Group, Note, PaneHead, Row, Segmented } from "./settings-ui.js";

// Temporary classifier shadow report (#2957). Plain numbers and disagreement rows from the
// viewer's own shadow records. This page is not permanent: do not extend it, replace it with
// the Activity-history follow-up instead.
type RangeOption = "7" | "30" | "90";

const RANGE_OPTIONS: readonly { readonly value: RangeOption; readonly label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" }
];

function readRange(value: string): ClassifierShadowReportRange {
  const days = Number(value);
  return days === 7 || days === 90 ? days : 30;
}

function confidenceLabel(confidence: number | null): string {
  return confidence === null ? "unsure" : `${Math.round(confidence * 100)}% sure`;
}

export function ShadowReportPane(_props: PaneProps) {
  const locale = useUserLocale();
  const [range, setRange] = useState<RangeOption>("30");
  const days = readRange(range);
  const reportQuery = useQuery({
    queryKey: queryKeys.chat.classifierShadowReport(days),
    queryFn: () => getClassifierShadowReport(days),
    retry: false
  });

  return (
    <>
      <PaneHead
        title="Shadow report"
        desc="Temporary page: how the classifier's shadow guesses compare with what the main model did."
      />
      <Group
        title="Agreement"
        desc="Counted from your own shadow records only."
        action={
          <Segmented
            value={range}
            ariaLabel="Time range"
            onChange={(value) => setRange(value)}
            options={RANGE_OPTIONS}
          />
        }
      >
        {reportQuery.isPending ? (
          <p role="status">Loading shadow report…</p>
        ) : reportQuery.isError ? (
          <Note>{readError(reportQuery.error)}</Note>
        ) : reportQuery.data ? (
          <>
            <Row
              name="Messages checked"
              control={<strong>{reportQuery.data.report.checked}</strong>}
            />
            <Row
              name="Picked a tool"
              control={<strong>{reportQuery.data.report.pickedTool}</strong>}
            />
            <Row
              name="Main model agreed"
              desc={`Out of ${reportQuery.data.report.comparable} comparable messages.`}
              control={
                <strong>
                  {reportQuery.data.report.agreed} of {reportQuery.data.report.comparable}
                </strong>
              }
            />
            <Row
              name="Missed a tool"
              desc="The classifier named no tool but the chat used one."
              control={<strong>{reportQuery.data.report.missedTool}</strong>}
            />
          </>
        ) : null}
      </Group>
      <Group title="Disagreements" desc="Messages where the two picked different tools.">
        {reportQuery.isPending ? (
          <p role="status">Loading disagreements…</p>
        ) : reportQuery.isError ? (
          <Note>{readError(reportQuery.error)}</Note>
        ) : reportQuery.data ? (
          reportQuery.data.report.disagreements.length === 0 ? (
            <EmptyState
              title="No disagreements"
              description={
                reportQuery.data.report.checked === 0
                  ? "No shadow records for you in this range yet."
                  : "The classifier and the main model agreed on every comparable message."
              }
            />
          ) : (
            reportQuery.data.report.disagreements.map((row) => (
              <Row
                key={row.id}
                name={`${row.classifierTool ?? "No tool"} led to ${row.modelTool ?? "no tool"}`}
                desc={`${formatDate(row.createdAt, locale, { month: "long", day: "numeric" })} at ${formatTime(row.createdAt, locale)}, ${confidenceLabel(row.confidence)}.`}
              />
            ))
          )
        ) : null}
      </Group>
    </>
  );
}
