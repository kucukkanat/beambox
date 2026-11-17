# Alpine is already busybox + musl + apk (~8 MB unpacked). The guest needs nothing else:
# the terminal and file browser go through the microsandbox SDK, not an in-guest agent.
FROM alpine:3.22
LABEL org.opencontainers.image.title="beambox-base" \
      org.opencontainers.image.description="Beambox base template" \
      org.opencontainers.image.licenses="MIT"
