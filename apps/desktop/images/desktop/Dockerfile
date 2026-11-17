# X desktop for agents that need a GUI. noVNC lives in the app and the app's Rust proxy replaces
# websockify, so the image only needs an X server, a window manager and a VNC server.
FROM alpine:3.22
RUN apk add --no-cache xvfb x11vnc openbox xterm font-dejavu
COPY start-desktop /usr/local/bin/start-desktop
RUN chmod +x /usr/local/bin/start-desktop
ENV DISPLAY=:0
EXPOSE 5900
LABEL org.opencontainers.image.title="beambox-desktop" \
      org.opencontainers.image.description="Beambox desktop template: Xvfb, openbox and x11vnc" \
      org.opencontainers.image.licenses="MIT"
