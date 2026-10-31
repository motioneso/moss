// $2 is the stable original date. Mirror recurrence's anchored month-end/leap-year clamp.
export const BILL_MEMBERSHIP_SQL = `p.anchor_date <= $2::date AND (p.end_date IS NULL OR p.end_date >= $2::date) AND (
  (p.cadence='once' AND p.anchor_date=$2::date) OR
  (p.cadence='weekly' AND (($2::date-p.anchor_date)%7)=0) OR
  (p.cadence='fortnightly' AND (($2::date-p.anchor_date)%14)=0) OR
  (p.cadence IN ('monthly','yearly') AND (p.cadence='monthly' OR extract(month FROM p.anchor_date)=extract(month FROM $2::date))
    AND $2::date=make_date(extract(year FROM $2::date)::integer,extract(month FROM $2::date)::integer,
      least(extract(day FROM p.anchor_date)::integer,extract(day FROM (date_trunc('month',$2::date)+interval '1 month -1 day'))::integer)))
)`;
