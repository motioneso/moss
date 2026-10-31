# Card-payment reserve UI evidence

Original Chromium screenshots from the installed synthetic Finance application. No image
editing, real bank data, bank connection or payment. Production UI, host confirmation routes,
worker, SQL and owner RLS are real; provider/credential ports in the shared acceptance fixture
are disclosed synthetic stand-ins.

Full Finance receipt 190526-A6wcPC at clean 9c0735e1 passed all 203 tests, including all
22 native flows. These images come from that run:

- [Phone setup, dark, 320px](finance-card-setup-dark-320.png): payment cash and resulting Ready
  are above the fixed footer; keyboard focus stays inside the shared dialog.
- [Saved reserve, light, 1440px](finance-card-saved-light-1440.png): the initial 100 USD debt
  assignment plus 50 USD funded purchase reserves 150 USD; earlier accounting is retained.

The expanded installed payment flow passed at clean da66aeb8 (receipt 191354-BK0Kda,
one selected case, 21 intentionally skipped). Production code is unchanged from 9c0735e1.
These original additional images come from that run:

- [Host confirmation, phone](finance-card-payment-host-confirm.png): no ledger movement occurs
  before the host decision; the underlying transfer review says no bank instruction is sent.
- [After the recorded payment, desktop](finance-card-payment-light-1440.png): the 100 USD
  payment leaves cash 900, debt 450, reserve 50 and Ready 800; category spending stays 50.
- [Payment-cash shortfall, phone dark](finance-card-overspent-dark-320.png): after releasing
  the remaining reserve, a 25 USD refund makes payment cash negative. Target funding is
  blocked until coverage is reviewed. The succeeding coverage step is asserted by the test.

[Design and official comparison sources](../../specs/2026-10-30-finance-card-payment-reserves.md).
[Current verification and limitations](../../plans/2026-10-30-finance-card-reserves-checkpoint.md).
