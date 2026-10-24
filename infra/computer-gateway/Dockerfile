# Packaging recipe only; exact built image still requires independent qualification.
FROM node:24-bookworm-slim@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae
WORKDIR /opt/moss-computer
ENV NODE_ENV=production
COPY --chown=0:0 --chmod=0444 gateway.cjs ./gateway.cjs
USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/node", "--max-old-space-size=64", "/opt/moss-computer/gateway.cjs"]
CMD ["/config/gateway.json"]
