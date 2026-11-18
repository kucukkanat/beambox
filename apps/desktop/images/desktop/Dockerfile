# The Beambox desktop as a standalone image: docker run -p 127.0.0.1:5900:5900 ghcr.io/OWNER/beambox-desktop
# Built for linux/amd64 and linux/arm64 by .github/workflows/desktop-image.yml. Beambox's local build runs the
# same install.sh.
FROM debian:trixie-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="Beambox desktop" \
  org.opencontainers.image.description="A macOS-like Linux desktop over VNC: openbox, a top bar, a dock and Chromium" \
  org.opencontainers.image.source="https://github.com/OWNER/beambox" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.version="$VERSION"
COPY . /tmp/beambox-desktop
RUN sh /tmp/beambox-desktop/install.sh && rm -rf /tmp/beambox-desktop
EXPOSE 5900
CMD ["beambox-desktop"]
