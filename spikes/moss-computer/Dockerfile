# Internal, offline qualification candidate; not a supported release image.
FROM debian:bookworm-slim@sha256:ec31d744f83f4a73447ba045aaab9409997efe5cc706eca4890c1be36cc1606a

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates dbus-x11 firefox-esr fonts-dejavu gettext-base \
    nginx-light novnc procps python3 tini tigervnc-standalone-server \
    websockify x11-utils xclip xdotool xfce4-session xfce4-panel \
    xfce4-terminal xfdesktop4 xfwm4 thunar \
    && dpkg-query -W > /usr/share/computer-packages.txt \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 desktop \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash desktop

COPY entrypoint.sh /usr/local/bin/computer-desktop
COPY fixture.html /opt/computer/fixture.html
RUN chmod 0555 /usr/local/bin/computer-desktop

ENV HOME=/home/desktop DISPLAY=:0 XDG_RUNTIME_DIR=/run/desktop
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/computer-desktop"]
