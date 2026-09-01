#!/bin/sh
# Bring up the accessibility stack on a Solari desktop, detached.
#
# Run this through `process.start`, never `exec`: every daemon here holds a file
# descriptor open, and an exec waits for an EOF that never arrives.
set -x
export HOME=/root
export DISPLAY=:0
export XDG_RUNTIME_DIR=/run/user/0
export GTK_MODULES=gail:atk-bridge
export QT_ACCESSIBILITY=1
mkdir -p /run/user/0
chmod 700 /run/user/0

# AT-SPI is a D-Bus service, so a session bus is not optional.
if [ ! -f /tmp/dbus.env ]; then
  dbus-launch --sh-syntax > /tmp/dbus.env 2>/dev/null
fi
. /tmp/dbus.env

# The registry is what actually exposes application accessibility trees.
/usr/libexec/at-spi-bus-launcher --launch-immediately > /tmp/atspi.log 2>&1 &
sleep 2
/usr/libexec/at-spi2-registryd > /tmp/atspi-reg.log 2>&1 &
sleep 2

# Orca itself. We do not capture its audio — speech-dispatcher's sd_generic
# module will not load on this image, and going through a synthesiser would only
# add a transcription step between us and facts we can read directly. Orca runs
# because it is the real screen reader querying the tree, and because a
# demonstration of accessibility should have one actually running.
# --no-setup skips a first-run wizard that blocks forever with nobody at the keyboard.
orca --replace --no-setup > /tmp/orca.log 2>&1 &
sleep 4
echo done > /tmp/gauntlet-setup-done
