# Public toolchain input only. The immutable upstream image pins Node, Chromium and its libs.
FROM mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948 AS public-tools
WORKDIR /build
COPY infra/workshop/package.json infra/workshop/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY infra/workshop/collect-runtime.mjs ./
RUN node collect-runtime.mjs

FROM scratch
COPY --from=public-tools /runtime/ /
COPY packages/module-sdk/src/ /opt/module-sdk/
COPY packages/module-web-sdk/src/ /opt/module-web-sdk/
COPY packages/ui/src/ /opt/ui/
COPY apps/web/src/styles/tokens.css /opt/ui/tokens.css
COPY infra/workshop/source.mjs infra/workshop/run.mjs infra/workshop/render.mjs /opt/workshop/
USER 1000:1000
WORKDIR /attempt
ENV HOME=/attempt/home TMPDIR=/attempt/tmp PATH=/usr/local/bin
ENTRYPOINT ["/usr/local/bin/node", "/opt/workshop/run.mjs"]
