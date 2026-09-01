#!/usr/bin/env python3
"""Record what a screen reader would announce, straight from AT-SPI.

Orca does not invent its announcements: it reads the accessibility tree over the
AT-SPI D-Bus and speaks the focused object's name, role and state. This listens
to the same bus and writes the same facts to a file — one line per focus change.

Capturing this rather than the audio means no synthesiser, no transcription, and
a transcript that is exactly what the toolkit exposed. If a control is announced
here as "push button" with no name, that is precisely what a blind user hears.
"""
import sys
import pyatspi

LOG = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gauntlet-speech.log"


def describe(acc):
    try:
        name = (acc.name or "").strip()
        role = acc.getRoleName()
        states = acc.getState()
        bits = []
        if states.contains(pyatspi.STATE_FOCUSED):
            bits.append("focused")
        if not states.contains(pyatspi.STATE_ENABLED):
            bits.append("disabled")
        # What a screen reader reads out: the name, then what kind of thing it is.
        text = f'{name if name else "(no accessible name)"} — {role}'
        if bits:
            text += f' [{", ".join(bits)}]'
        return text
    except Exception as exc:  # a dying window can vanish mid-read
        return f"(unreadable: {exc})"


def on_focus(event):
    if not event.detail1:  # focus lost, not gained
        return
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(describe(event.source) + "\n")
        fh.flush()


pyatspi.Registry.registerEventListener(on_focus, "object:state-changed:focused")
with open(LOG, "a", encoding="utf-8") as fh:
    fh.write("(listener attached)\n")
pyatspi.Registry.start()
