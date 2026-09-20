"""Stop paid workers when the platform that owns them disappears."""
import os
import signal
import threading


def watch_parent(pid: int | None) -> threading.Event:
    stopped = threading.Event()
    if pid is None:
        return stopped

    def watch():
        while not stopped.wait(1):
            # Reparenting is authoritative and avoids confusing a reused PID
            # with the original owner. SIGINT lets Inspect flush partial logs.
            if os.getppid() != pid:
                os.kill(os.getpid(), signal.SIGINT)
                return

    threading.Thread(target=watch, daemon=True).start()
    return stopped
