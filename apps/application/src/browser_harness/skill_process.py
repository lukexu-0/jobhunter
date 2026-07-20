from __future__ import annotations

import argparse
import codecs
import io
import json
import math
import os
import queue
import resource
import signal
import subprocess
import sys
import threading
import time
from typing import Any, BinaryIO, NoReturn



_MAX_FRAME_BYTES = 1024 * 1024
_MAX_SOURCE_BYTES = 65_536
_OUTPUT_TAIL_CHARS = 20_000
_MARKER_MAX_CHARS = 16_000
_READ_CHUNK_BYTES = 8192
_INVOCATION_TIMEOUT_SECONDS = 120.0

_CORE_LIMIT = 0
_NOFILE_LIMIT = 512
_NPROC_LIMIT = 128
_FSIZE_LIMIT = 128 * 1024 * 1024
_CPU_LIMIT = 120
_AS_LIMIT = 2 * 1024 * 1024 * 1024
_daemon_pid: int | None = None
_daemon_reaper: threading.Thread | None = None
_daemon_start_time: object | None = None
_execution_lock = threading.Lock()
_active_invocation: subprocess.Popen[bytes] | None = None
_execution_in_flight = False
_execution_cancelled = False
_execution_cancel_failed = False


class _ProtocolError(Exception):
    pass


class _BrowserFailure(Exception):
    pass

class _ProtocolWriteError(Exception):
    pass


class _Utf8Tail:
    """Drain a binary stream while retaining only its decoded UTF-8 tail."""

    def __init__(self, stream: BinaryIO, limit: int = _OUTPUT_TAIL_CHARS) -> None:
        self._stream = stream
        self._limit = limit
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._tail = ""
        self.truncated = False
        self.failed = False

    @property
    def text(self) -> str:
        return self._tail

    def _append(self, text: str) -> None:
        if not text:
            return
        combined = self._tail + text
        if len(combined) > self._limit:
            self.truncated = True
            combined = combined[-self._limit :]
        self._tail = combined

    def drain(self) -> None:
        try:
            while True:
                chunk = self._stream.read(_READ_CHUNK_BYTES)
                if not chunk:
                    break
                self._append(self._decoder.decode(chunk))
            self._append(self._decoder.decode(b"", final=True))
        except (OSError, ValueError):
            self.failed = True
        finally:
            try:
                self._stream.close()
            except OSError:
                self.failed = True


def _set_exact_limit(limit: int, value: int) -> None:
    resource.setrlimit(limit, (value, value))
    if resource.getrlimit(limit) != (value, value):
        raise _BrowserFailure


def _apply_supervisor_limits() -> None:
    try:
        _set_exact_limit(resource.RLIMIT_CORE, _CORE_LIMIT)
        _set_exact_limit(resource.RLIMIT_NOFILE, _NOFILE_LIMIT)
        _set_exact_limit(resource.RLIMIT_NPROC, _NPROC_LIMIT)
        _set_exact_limit(resource.RLIMIT_FSIZE, _FSIZE_LIMIT)
    except (OSError, ValueError):
        raise _BrowserFailure from None


def _apply_invocation_limits() -> None:
    try:
        _set_exact_limit(resource.RLIMIT_CPU, _CPU_LIMIT)
        _set_exact_limit(resource.RLIMIT_AS, _AS_LIMIT)
    except (OSError, ValueError):
        raise _BrowserFailure from None


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise _ProtocolError
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _reject_json_constant(_value: str) -> NoReturn:
    raise _ProtocolError


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise _ProtocolError
        value[key] = item
    return value


def _read_request(stream: BinaryIO) -> dict[str, Any]:
    prefix = _read_exact(stream, 4)
    length = int.from_bytes(prefix, "big")
    if length <= 0 or length > _MAX_FRAME_BYTES:
        raise _ProtocolError
    payload = _read_exact(stream, length)
    try:
        text = payload.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        RecursionError,
        _ProtocolError,
    ):
        raise _ProtocolError from None
    if type(value) is not dict:
        raise _ProtocolError
    return value


def _encode_frame(value: dict[str, Any]) -> bytes:
    try:
        payload = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeEncodeError, RecursionError):
        raise _BrowserFailure from None
    if len(payload) > _MAX_FRAME_BYTES:
        raise _BrowserFailure
    return len(payload).to_bytes(4, "big") + payload


def _write_frame(stream: BinaryIO, value: dict[str, Any]) -> None:
    frame = _encode_frame(value)
    try:
        stream.write(frame)
        stream.flush()
    except (BrokenPipeError, OSError, ValueError):
        raise _ProtocolWriteError from None


def _error_response() -> dict[str, Any]:
    return {"ok": False, "error": "browser_failed"}


def _empty_success_response() -> dict[str, Any]:
    return {
        "ok": True,
        "exit_code": 0,
        "timed_out": False,
        "deadline_exhausted": False,
        "stdout": "",
        "stderr": "",
        "stdout_truncated": False,
        "stderr_truncated": False,
        "marker": None,
        "cancelled": False,
    }


def _validated_request(request: dict[str, Any]) -> tuple[str, bytes | None]:
    if request == {"op": "stop_daemon"}:
        return "stop_daemon", None
    if set(request) != {"op", "code"} or request.get("op") != "execute":
        raise _ProtocolError
    code = request.get("code")
    if type(code) is not str:
        raise _ProtocolError
    try:
        source = code.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise _ProtocolError from None
    if len(source) > _MAX_SOURCE_BYTES:
        raise _ProtocolError
    return "execute", source


def _session_deadline() -> float:
    raw = os.environ.get("JOBHUNTER_SESSION_DEADLINE")
    try:
        deadline = float(raw) if raw is not None else math.nan
    except ValueError:
        raise _BrowserFailure from None
    if not math.isfinite(deadline):
        raise _BrowserFailure
    return deadline


def _write_source(stream: BinaryIO, source: bytes, failed: list[bool]) -> None:
    try:
        stream.write(source)
        stream.flush()
    except (BrokenPipeError, OSError, ValueError):
        failed[0] = True
    finally:
        try:
            stream.close()
        except OSError:
            failed[0] = True


def _signal_invocation_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        raise _BrowserFailure from None


def _begin_execution() -> None:
    global _active_invocation
    global _execution_cancel_failed
    global _execution_cancelled
    global _execution_in_flight
    with _execution_lock:
        if _execution_in_flight:
            raise _BrowserFailure
        _active_invocation = None
        _execution_cancel_failed = False
        _execution_cancelled = False
        _execution_in_flight = True


def _register_active_invocation(process: subprocess.Popen[bytes]) -> None:
    global _active_invocation
    with _execution_lock:
        if not _execution_in_flight or _active_invocation is not None:
            raise _BrowserFailure
        _active_invocation = process
        cancelled = _execution_cancelled
    if cancelled:
        _signal_invocation_group(process)


def _request_execution_cancel() -> None:
    global _execution_cancel_failed
    global _execution_cancelled
    with _execution_lock:
        if not _execution_in_flight:
            return
        _execution_cancelled = True
        process = _active_invocation
    if process is not None:
        try:
            _signal_invocation_group(process)
        except _BrowserFailure:
            with _execution_lock:
                _execution_cancel_failed = True


def _execution_was_cancelled() -> bool:
    with _execution_lock:
        return _execution_in_flight and _execution_cancelled


def _complete_execution(
    response: dict[str, Any] | None,
) -> dict[str, Any] | None:
    global _active_invocation
    global _execution_cancel_failed
    global _execution_cancelled
    global _execution_in_flight
    with _execution_lock:
        cancelled = _execution_cancelled
        cancel_failed = _execution_cancel_failed
        _active_invocation = None
        _execution_cancel_failed = False
        _execution_cancelled = False
        _execution_in_flight = False
    if cancel_failed:
        raise _BrowserFailure
    if response is not None:
        response["cancelled"] = cancelled
    return response


def _kill_invocation_group(process: subprocess.Popen[bytes]) -> None:
    _signal_invocation_group(process)
    try:
        process.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        raise _BrowserFailure from None


def _direct_child_pids() -> list[int]:
    children: list[int] = []
    supervisor_pid = os.getpid()
    parent_pids = {1, supervisor_pid}
    try:
        entries = os.scandir("/proc")
    except OSError:
        raise _BrowserFailure from None
    with entries:
        for entry in entries:
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            if pid in {_daemon_pid, supervisor_pid}:
                continue
            try:
                with open(
                    f"/proc/{pid}/stat",
                    "r",
                    encoding="utf-8",
                    errors="strict",
                ) as stat_file:
                    process_stat = stat_file.read()
                closing_parenthesis = process_stat.rfind(")")
                fields = process_stat[closing_parenthesis + 2 :].split()
                if closing_parenthesis < 0 or len(fields) < 2:
                    raise ValueError
                if int(fields[1]) in parent_pids:
                    children.append(pid)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except (OSError, UnicodeError, ValueError):
                raise _BrowserFailure from None
    return children


def _cleanup_invocation_descendants() -> None:
    deadline = time.monotonic() + 5.0
    while children := _direct_child_pids():
        for pid in children:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                raise _BrowserFailure from None
        for pid in children:
            try:
                os.waitpid(pid, 0)
            except (ChildProcessError, ProcessLookupError):
                pass
            except OSError:
                raise _BrowserFailure from None
        if time.monotonic() >= deadline:
            raise _BrowserFailure


def _execute(source: bytes) -> dict[str, Any]:
    if not _original_daemon_alive():
        raise _BrowserFailure
    deadline = _session_deadline()
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {
            "ok": True,
            "exit_code": 124,
            "timed_out": True,
            "deadline_exhausted": True,
            "stdout": "",
            "stderr": "",
            "stdout_truncated": False,
            "stderr_truncated": False,
            "marker": None,
        }

    try:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "jobhunter_browser_harness.skill_process",
                "--invoke",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
            start_new_session=True,
            preexec_fn=_apply_invocation_limits,
        )
    except (OSError, subprocess.SubprocessError):
        raise _BrowserFailure from None
    _register_active_invocation(process)

    if process.stdin is None or process.stdout is None or process.stderr is None:
        _kill_invocation_group(process)
        raise _BrowserFailure

    stdout_tail = _Utf8Tail(process.stdout)
    stderr_tail = _Utf8Tail(process.stderr)
    write_failed = [False]
    threads = [
        threading.Thread(target=stdout_tail.drain, daemon=True),
        threading.Thread(target=stderr_tail.drain, daemon=True),
        threading.Thread(
            target=_write_source,
            args=(process.stdin, source, write_failed),
            daemon=True,
        ),
    ]
    for thread in threads:
        thread.start()
    remaining = deadline - time.monotonic()
    timeout = max(0.001, min(_INVOCATION_TIMEOUT_SECONDS, remaining))
    deadline_is_limit = remaining <= _INVOCATION_TIMEOUT_SECONDS

    timed_out = False
    deadline_exhausted = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        deadline_exhausted = deadline_is_limit
        _kill_invocation_group(process)
    except BaseException:
        _kill_invocation_group(process)
        raise

    daemon_replaced = not _original_daemon_alive()
    _cleanup_invocation_descendants()
    if daemon_replaced or not _original_daemon_alive():
        _cleanup_invocation_descendants()
        raise _BrowserFailure

    for thread in threads:
        thread.join(timeout=5.0)
    if any(thread.is_alive() for thread in threads):
        _kill_invocation_group(process)
        raise _BrowserFailure
    if stdout_tail.failed or stderr_tail.failed:
        raise _BrowserFailure
    if write_failed[0] and process.returncode == 0:
        raise _BrowserFailure
    if process.returncode is None:
        raise _BrowserFailure

    if time.monotonic() >= deadline:
        deadline_exhausted = True
    marker = None
    if not deadline_exhausted and not _execution_was_cancelled():
        marker = _observation_payload()
    stdout = stdout_tail.text
    stdout_truncated = stdout_tail.truncated

    return {
        "ok": True,
        "exit_code": process.returncode,
        "timed_out": timed_out,
        "deadline_exhausted": deadline_exhausted,
        "stdout": stdout,
        "stderr": stderr_tail.text,
        "stdout_truncated": stdout_truncated,
        "stderr_truncated": stderr_tail.truncated,
        "marker": marker,
    }


def _replace_stdin_with_devnull() -> None:
    try:
        descriptor = os.open("/dev/null", os.O_RDONLY)
        try:
            os.dup2(descriptor, 0)
        finally:
            if descriptor != 0:
                os.close(descriptor)
    except OSError:
        raise _BrowserFailure from None


def _reap_daemon(pid: int) -> None:
    try:
        os.waitpid(pid, 0)
    except (ChildProcessError, OSError):
        return


def _start_daemon() -> None:
    global _daemon_pid, _daemon_reaper, _daemon_start_time
    try:
        from browser_harness import admin, helpers

        del helpers

        admin.ensure_daemon()
        daemon_pid = admin.ipc.identify(admin.NAME, timeout=1.0)
        daemon_start_time = admin._process_start_time(daemon_pid)
        if (
            type(daemon_pid) is not int
            or daemon_pid <= 0
            or daemon_start_time is None
        ):
            raise _BrowserFailure
        reaper = threading.Thread(
            target=_reap_daemon,
            args=(daemon_pid,),
            daemon=True,
            name="browser-harness-daemon-reaper",
        )
        reaper.start()
        _daemon_pid = daemon_pid
        _daemon_start_time = daemon_start_time
        _daemon_reaper = reaper
    except _BrowserFailure:
        raise
    except Exception:
        raise _BrowserFailure from None


def _original_daemon_alive() -> bool:
    try:
        from browser_harness import admin

        daemon_pid = _daemon_pid
        daemon_start_time = _daemon_start_time
        return (
            type(daemon_pid) is int
            and daemon_pid > 0
            and daemon_start_time is not None
            and admin.ipc.identify(admin.NAME, timeout=1.0) == daemon_pid
            and admin._process_start_time(daemon_pid) == daemon_start_time
        )
    except Exception:
        return False


def _stop_daemon() -> dict[str, Any]:
    try:
        from browser_harness import admin

        daemon_pid = _daemon_pid
        daemon_start = admin._process_start_time(daemon_pid)
        admin.restart_daemon()
        reaper = _daemon_reaper
        if reaper is not None:
            reaper.join(timeout=5.0)
        if (
            daemon_pid is not None
            and daemon_start is not None
            and admin._process_start_time(daemon_pid) == daemon_start
        ):
            try:
                os.kill(daemon_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if reaper is not None:
                reaper.join(timeout=5.0)
        if (
            admin.daemon_alive()
            or (
                daemon_pid is not None
                and daemon_start is not None
                and admin._process_start_time(daemon_pid) == daemon_start
            )
        ):
            raise _BrowserFailure
    except _BrowserFailure:
        raise
    except Exception:
        raise _BrowserFailure from None
    return _empty_success_response()


def _read_server_requests(
    protocol_in: BinaryIO,
    requests: queue.Queue[tuple[str, bytes | None]],
) -> None:
    while True:
        try:
            request = _read_request(protocol_in)
            if request == {"op": "cancel"}:
                _request_execution_cancel()
                continue
            operation = _validated_request(request)
            if operation[0] == "execute":
                _begin_execution()
            requests.put(operation)
        except _ProtocolError:
            requests.put(("protocol_error", None))
            return
        except _BrowserFailure:
            requests.put(("server_error", None))
            return


def _server_main() -> int:
    protocol_out = sys.stdout.buffer
    try:
        protocol_in = os.fdopen(os.dup(0), "rb", buffering=0)
        _replace_stdin_with_devnull()
        _apply_supervisor_limits()
        _start_daemon()
    except (OSError, _BrowserFailure):
        try:
            _write_frame(protocol_out, _error_response())
        except (_BrowserFailure, _ProtocolWriteError):
            pass
        return 1

    requests: queue.Queue[tuple[str, bytes | None]] = queue.Queue(maxsize=8)
    request_reader = threading.Thread(
        target=_read_server_requests,
        args=(protocol_in, requests),
        daemon=True,
        name="browser-skill-request-reader",
    )
    request_reader.start()

    while True:
        try:
            operation, source = requests.get()
            if operation == "protocol_error":
                raise _ProtocolError
            if operation == "server_error":
                raise _BrowserFailure
            if operation == "execute":
                if source is None:
                    raise _BrowserFailure
                try:
                    response = _execute(source)
                except BaseException:
                    _complete_execution(None)
                    raise
                completed_response = _complete_execution(response)
                if completed_response is None:
                    raise _BrowserFailure
                response = completed_response
            else:
                response = _stop_daemon()
            _write_frame(protocol_out, response)
        except _ProtocolWriteError:
            return 1
        except _ProtocolError:
            try:
                _write_frame(protocol_out, _error_response())
            except (_BrowserFailure, _ProtocolWriteError):
                pass
            return 1
        except _BrowserFailure:
            try:
                _write_frame(protocol_out, _error_response())
            except (_BrowserFailure, _ProtocolWriteError):
                pass
            return 1


def _observation_payload() -> dict[str, Any] | None:
    try:
        from browser_harness.helpers import current_tab, page_info

        current = current_tab()
        if not isinstance(current, dict):
            return None
        target_id = current.get("targetId") or current.get("target_id")
        if not isinstance(target_id, str) or not target_id:
            return None
        normalized_current = {
            "targetId": target_id[:512],
            "url": str(current.get("url", ""))[:4_096],
            "title": str(current.get("title", ""))[:4_096],
        }
        try:
            page = page_info()
        except Exception:
            page = None
        if not isinstance(page, dict):
            page = None
        payload = {"current_tab": normalized_current, "page_info": page}
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
        if len(encoded) > _MARKER_MAX_CHARS:
            payload["page_info"] = None
            encoded = json.dumps(
                payload,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
        if len(encoded) > _MARKER_MAX_CHARS:
            return None
        return payload
    except Exception:
        return None




def _invoke_main() -> NoReturn:
    _apply_invocation_limits()
    source = sys.stdin.buffer.read(_MAX_SOURCE_BYTES + 1)
    try:
        sys.stdin.buffer.close()
    except OSError:
        raise _BrowserFailure from None
    _replace_stdin_with_devnull()
    if len(source) > _MAX_SOURCE_BYTES:
        raise SystemExit(1)
    try:
        code = source.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise SystemExit(1) from None

    wrapper = (
        "exec(compile("
        + repr(code)
        + ", '<jobhunter-browser-use>', 'exec'), globals(), globals())"
    )
    sys.stdin = io.StringIO(wrapper)
    sys.argv = [sys.argv[0]]

    from browser_harness.admin import daemon_alive

    if not daemon_alive():
        raise RuntimeError("browser-harness daemon is unavailable")
    from browser_use import cli as browser_use_cli

    result = browser_use_cli.main()
    raise SystemExit(result or 0)


def _parse_mode(argv: list[str]) -> str:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--server", action="store_true")
    modes.add_argument("--invoke", action="store_true")
    arguments = parser.parse_args(argv)
    return "server" if arguments.server else "invoke"


def main(argv: list[str] | None = None) -> int:
    mode = _parse_mode(sys.argv[1:] if argv is None else argv)
    if mode == "server":
        return _server_main()
    _invoke_main()


__all__ = ["main"]


if __name__ == "__main__":
    raise SystemExit(main())
