from __future__ import annotations

import argparse
import codecs
import io
import json
import math
import os
import resource
import signal
import subprocess
import sys
import threading
import time
from typing import Any, BinaryIO, NoReturn


RESULT_MARKER_START = "\x1eJOBHUNTER_BROWSER_RESULT:"
RESULT_MARKER_END = ":JOBHUNTER_BROWSER_RESULT_END\x1e"

_MAX_FRAME_BYTES = 1024 * 1024
_MAX_SOURCE_BYTES = 65_536
_OUTPUT_TAIL_CHARS = 20_000
_READ_CHUNK_BYTES = 8192
_INVOCATION_TIMEOUT_SECONDS = 120.0

_CORE_LIMIT = 0
_NOFILE_LIMIT = 512
_NPROC_LIMIT = 128
_FSIZE_LIMIT = 128 * 1024 * 1024
_CPU_LIMIT = 120
_AS_LIMIT = 2 * 1024 * 1024 * 1024


class _ProtocolError(Exception):
    pass


class _BrowserFailure(Exception):
    pass

class _ProtocolWriteError(Exception):
    pass


class _Utf8Tail:
    """Drain a binary stream while retaining only its decoded UTF-8 tail."""

    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream
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
        if len(combined) > _OUTPUT_TAIL_CHARS:
            self.truncated = True
            combined = combined[-_OUTPUT_TAIL_CHARS:]
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
    except (UnicodeDecodeError, json.JSONDecodeError, _ProtocolError):
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
    except (TypeError, ValueError, UnicodeEncodeError):
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


def _kill_invocation_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        raise _BrowserFailure from None
    try:
        process.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        raise _BrowserFailure from None


def _execute(source: bytes) -> dict[str, Any]:
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
        }

    timeout = min(_INVOCATION_TIMEOUT_SECONDS, remaining)
    deadline_is_limit = remaining <= _INVOCATION_TIMEOUT_SECONDS
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

    return {
        "ok": True,
        "exit_code": process.returncode,
        "timed_out": timed_out,
        "deadline_exhausted": deadline_exhausted,
        "stdout": stdout_tail.text,
        "stderr": stderr_tail.text,
        "stdout_truncated": stdout_tail.truncated,
        "stderr_truncated": stderr_tail.truncated,
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


def _start_daemon() -> None:
    try:
        from browser_harness.admin import ensure_daemon

        ensure_daemon()
    except Exception:
        raise _BrowserFailure from None


def _stop_daemon() -> dict[str, Any]:
    try:
        from browser_harness.admin import daemon_alive, restart_daemon

        restart_daemon()
        if daemon_alive():
            raise _BrowserFailure
    except _BrowserFailure:
        raise
    except Exception:
        raise _BrowserFailure from None
    return _empty_success_response()


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

    while True:
        try:
            request = _read_request(protocol_in)
            operation, source = _validated_request(request)
            if operation == "execute":
                if source is None:
                    raise _BrowserFailure
                response = _execute(source)
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


def _observation_marker() -> str:
    current: Any = None
    page: Any = None
    try:
        from browser_harness.helpers import current_tab, page_info

        try:
            current = current_tab()
        except Exception:
            current = None
        try:
            page = page_info()
        except Exception:
            page = None
    except Exception:
        pass

    try:
        payload = json.dumps(
            {"current_tab": current, "page_info": page},
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    except (TypeError, ValueError):
        payload = '{"current_tab":null,"page_info":null}'
    return f"{RESULT_MARKER_START}{payload}{RESULT_MARKER_END}"


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

    result: int | None = 1
    try:
        from browser_use import cli as browser_use_cli

        result = browser_use_cli.main()
    finally:
        print(_observation_marker(), flush=True)
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


__all__ = ["RESULT_MARKER_END", "RESULT_MARKER_START", "main"]


if __name__ == "__main__":
    raise SystemExit(main())
