from __future__ import annotations

import asyncio
import codecs
import errno
import hashlib
import os
import re
import sys
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final
from uuid import UUID

import yaml
from fastapi import UploadFile
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode, ScalarNode

from .models import (
    APPLICATION_ANECDOTE_MAX_BYTES,
    APPLICATION_ANECDOTE_MAX_COUNT,
    APPLICATION_ANECDOTE_TOTAL_MAX_BYTES,
    APPLICATION_CONTEXT_MAX_BYTES,
    APPLICATION_CONTEXT_MAX_COUNT,
    APPLICATION_CONTEXT_TOTAL_MAX_BYTES,
    APPLICATION_PROFILE_MAX_BYTES,
    APPLICATION_RESUME_MAX_BYTES,
    APPLICATION_RESUME_SOURCE_MAX_BYTES,
    DIRECT_FIELD_NAMES,
    HarnessServiceError,
)


_CHUNK_SIZE: Final = 64 * 1024
_INVALID_REQUEST_MESSAGE: Final = "Request is invalid"
_DIRECTORY_FLAGS: Final = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
_FILE_FLAGS: Final = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
_SAFE_FILENAME_CHARACTER: Final = re.compile(r"[^A-Za-z0-9._-]+")
_REPEATED_UNDERSCORE: Final = re.compile(r"_+")


_PENDING_CLEANUP: set[Path] = set()


@dataclass(frozen=True, slots=True)
class StoredUpload:
    path: Path
    display_name: str


@dataclass(frozen=True, slots=True)
class PersonalInformation:
    direct_fields: tuple[tuple[str, str], ...]
    narrative: str


@dataclass(frozen=True, slots=True)
class StoredCandidateArtifacts:
    session_directory: Path
    personal_upload: StoredUpload
    resume: StoredUpload
    resume_source: StoredUpload
    contexts: tuple[StoredUpload, ...]
    anecdotes: tuple[StoredUpload, ...]
    personal: PersonalInformation


class _UniqueKeySafeLoader(yaml.SafeLoader):
    pass


def _construct_unique_mapping(
    loader: _UniqueKeySafeLoader, node: MappingNode, deep: bool = False
) -> dict[object, object]:
    if not isinstance(node, MappingNode):
        raise ConstructorError(None, None, "expected a mapping node", node.start_mark)

    raw_keys: set[str] = set()
    for key_node, _ in node.value:
        if key_node.tag == "tag:yaml.org,2002:merge" or key_node.value == "<<":
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                "YAML merge keys are not allowed",
                key_node.start_mark,
            )
        if not isinstance(key_node, ScalarNode):
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                "mapping keys must be scalars",
                key_node.start_mark,
            )
        if key_node.value in raw_keys:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                "duplicate mapping key",
                key_node.start_mark,
            )
        raw_keys.add(key_node.value)

    return yaml.SafeLoader.construct_mapping(loader, node, deep=deep)


_UniqueKeySafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_unique_mapping
)


def _invalid_request() -> HarnessServiceError:
    return HarnessServiceError(422, "invalid_request", _INVALID_REQUEST_MESSAGE)


def _absolute_path(path: Path) -> Path:
    lexical = Path(path)
    if ".." in lexical.parts:
        raise ValueError("artifact paths cannot contain parent traversal")
    return Path(os.path.abspath(os.fspath(lexical)))


def _open_directory_chain(path: Path, *, create: bool) -> tuple[int, Path]:
    absolute = _absolute_path(path)
    parts = absolute.parts
    if len(parts) <= 1:
        raise ValueError("a filesystem root cannot be an artifact directory")

    descriptor = os.open(parts[0], _DIRECTORY_FLAGS)
    try:
        for part in parts[1:]:
            next_descriptor: int | None = None
            try:
                try:
                    next_descriptor = os.open(
                        part, _DIRECTORY_FLAGS, dir_fd=descriptor
                    )
                except FileNotFoundError:
                    if not create:
                        raise
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                    next_descriptor = os.open(
                        part, _DIRECTORY_FLAGS, dir_fd=descriptor
                    )
                    os.fchmod(next_descriptor, 0o700)
            except BaseException:
                if next_descriptor is not None:
                    os.close(next_descriptor)
                raise
            if next_descriptor is None:
                raise RuntimeError("failed to open artifact directory")
            previous_descriptor = descriptor
            descriptor = next_descriptor
            os.close(previous_descriptor)
        return descriptor, absolute
    except BaseException:
        os.close(descriptor)
        raise


def _canonical_session_name(session_id: UUID | str) -> str:
    parsed = session_id if isinstance(session_id, UUID) else UUID(str(session_id))
    return str(parsed)


def _create_session_directory(root: Path, session_id: UUID | str) -> tuple[int, Path]:
    session_name = _canonical_session_name(session_id)
    root_descriptor, absolute_root = _open_directory_chain(root, create=True)
    session_descriptor: int | None = None
    created = False
    try:
        os.fchmod(root_descriptor, 0o700)
        os.mkdir(session_name, mode=0o700, dir_fd=root_descriptor)
        created = True
        session_descriptor = os.open(
            session_name, _DIRECTORY_FLAGS, dir_fd=root_descriptor
        )
        os.fchmod(session_descriptor, 0o700)
        return session_descriptor, absolute_root / session_name
    except BaseException:
        if session_descriptor is not None:
            os.close(session_descriptor)
        if created:
            try:
                os.rmdir(session_name, dir_fd=root_descriptor)
            except OSError:
                pass
        raise
    finally:
        os.close(root_descriptor)


def create_session_artifact_directory(
    root: Path,
    session_id: UUID | str,
) -> Path:
    """Create one private UUID-named browser runtime artifact directory."""

    retry_pending_cleanup()
    descriptor, path = _create_session_directory(root, session_id)
    os.close(descriptor)
    return path


def _remove_contents(directory_descriptor: int) -> None:
    with os.scandir(directory_descriptor) as entries:
        names = tuple(entry.name for entry in entries)

    for name in names:
        try:
            child_descriptor = os.open(
                name, _DIRECTORY_FLAGS, dir_fd=directory_descriptor
            )
        except OSError as error:
            if error.errno not in (errno.ELOOP, errno.ENOTDIR):
                if error.errno == errno.ENOENT:
                    continue
                raise
            try:
                os.unlink(name, dir_fd=directory_descriptor)
            except FileNotFoundError:
                pass
            continue

        try:
            _remove_contents(child_descriptor)
        finally:
            os.close(child_descriptor)
        try:
            os.rmdir(name, dir_fd=directory_descriptor)
        except FileNotFoundError:
            pass


def remove_session_artifacts(path: Path) -> None:
    """Remove one artifact tree without ever following a symbolic link."""

    absolute = _absolute_path(path)
    if len(absolute.parts) <= 1:
        raise ValueError("refusing to remove a filesystem root")

    parent = absolute.parent
    leaf = absolute.name
    try:
        parent_descriptor, _ = _open_directory_chain(parent, create=False)
    except FileNotFoundError:
        return

    try:
        try:
            session_descriptor = os.open(leaf, _DIRECTORY_FLAGS, dir_fd=parent_descriptor)
        except FileNotFoundError:
            return
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                raise ValueError("artifact path is not a directory") from None
            raise

        try:
            _remove_contents(session_descriptor)
        finally:
            os.close(session_descriptor)
        try:
            os.rmdir(leaf, dir_fd=parent_descriptor)
        except FileNotFoundError:
            pass
    finally:
        os.close(parent_descriptor)


def _client_basename(upload: UploadFile) -> str:
    filename = upload.filename
    if not isinstance(filename, str) or not filename:
        raise ValueError("an upload filename is required")
    basename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    if not basename or basename in (".", ".."):
        raise ValueError("an upload filename is required")
    return basename


def _required_suffix(upload: UploadFile, allowed: frozenset[str]) -> str:
    basename = _client_basename(upload)
    suffix = Path(basename).suffix.lower()
    if suffix not in allowed:
        raise ValueError("the upload has an invalid extension")
    return suffix


def _sanitized_basename(upload: UploadFile, required_suffix: str) -> str:
    basename = unicodedata.normalize("NFKC", _client_basename(upload))
    source_stem = basename[: -len(required_suffix)]
    safe_stem = _SAFE_FILENAME_CHARACTER.sub("_", source_stem)
    safe_stem = _REPEATED_UNDERSCORE.sub("_", safe_stem).strip("._-")
    if not safe_stem:
        safe_stem = "upload"

    safe_suffix = required_suffix.lower()
    maximum_stem_length = 200 - len(safe_suffix)
    if len(safe_stem) > maximum_stem_length:
        digest = hashlib.sha256(basename.encode("utf-8")).hexdigest()[:12]
        prefix_length = maximum_stem_length - len(digest) - 1
        safe_stem = f"{safe_stem[:prefix_length]}-{digest}"
    return f"{safe_stem}{safe_suffix}"


def _open_unique_file(
    directory_descriptor: int, requested_name: str
) -> tuple[int, str]:
    suffix = Path(requested_name).suffix
    stem = requested_name[: -len(suffix)] if suffix else requested_name
    attempt = 1
    while True:
        name = requested_name if attempt == 1 else f"{stem}-{attempt}{suffix}"
        try:
            descriptor = os.open(
                name, _FILE_FLAGS, mode=0o600, dir_fd=directory_descriptor
            )
        except FileExistsError:
            attempt += 1
            continue
        try:
            os.fchmod(descriptor, 0o600)
        except BaseException:
            os.close(descriptor)
            try:
                os.unlink(name, dir_fd=directory_descriptor)
            except FileNotFoundError:
                pass
            raise
        return descriptor, name


def _utf8_decoder() -> codecs.IncrementalDecoder:
    return codecs.getincrementaldecoder("utf-8")(errors="strict")


async def _store_upload(
    upload: UploadFile,
    *,
    directory_descriptor: int,
    session_directory: Path,
    allowed_suffixes: frozenset[str],
    maximum_bytes: int,
    decode_utf8: bool,
    retain_text: bool = False,
    require_pdf_magic: bool = False,
) -> tuple[StoredUpload, int, str | None]:
    required_suffix = _required_suffix(upload, allowed_suffixes)
    requested_name = _sanitized_basename(upload, required_suffix)
    descriptor, stored_name = _open_unique_file(directory_descriptor, requested_name)
    decoder = _utf8_decoder() if decode_utf8 else None
    decoded_chunks: list[str] | None = [] if retain_text else None
    total = 0
    prefix = bytearray()

    descriptor_owned = True
    try:
        destination = os.fdopen(descriptor, "wb", closefd=True)
        descriptor_owned = False
        with destination:
            while True:
                chunk = await upload.read(_CHUNK_SIZE)
                if not chunk:
                    break
                if not isinstance(chunk, bytes):
                    raise ValueError("upload streams must yield bytes")
                new_total = total + len(chunk)
                if new_total > maximum_bytes:
                    raise ValueError("upload exceeds its byte limit")
                if require_pdf_magic and len(prefix) < 5:
                    prefix.extend(chunk[: 5 - len(prefix)])
                if decoder is not None:
                    decoded = decoder.decode(chunk, final=False)
                    if decoded_chunks is not None:
                        decoded_chunks.append(decoded)
                destination.write(chunk)
                total = new_total

            if decoder is not None:
                decoded = decoder.decode(b"", final=True)
                if decoded_chunks is not None:
                    decoded_chunks.append(decoded)
            destination.flush()
            os.fchmod(destination.fileno(), 0o600)
    except BaseException:
        if descriptor_owned:
            os.close(descriptor)
        try:
            os.unlink(stored_name, dir_fd=directory_descriptor)
        except FileNotFoundError:
            pass
        raise

    if require_pdf_magic and (total == 0 or bytes(prefix) != b"%PDF-"):
        os.unlink(stored_name, dir_fd=directory_descriptor)
        raise ValueError("resume is not a PDF")

    text = "".join(decoded_chunks) if decoded_chunks is not None else None
    return (
        StoredUpload(session_directory / stored_name, stored_name),
        total,
        text,
    )


def _line_without_ending(line: str) -> str:
    if line.endswith("\r\n"):
        return line[:-2]
    if line.endswith(("\n", "\r")):
        return line[:-1]
    return line


def _parse_personal_information(markdown: str) -> PersonalInformation:
    if markdown.startswith("\ufeff"):
        markdown = markdown[1:]
    lines = markdown.splitlines(keepends=True)
    if not lines or _line_without_ending(lines[0]) != "---":
        return PersonalInformation((), markdown)

    closing_index: int | None = None
    for index in range(1, len(lines)):
        if _line_without_ending(lines[index]) == "---":
            closing_index = index
            break
    if closing_index is None:
        raise ValueError("front matter is not closed")

    front_matter = "".join(lines[1:closing_index])
    loaded = yaml.load(front_matter, Loader=_UniqueKeySafeLoader)
    if loaded is None:
        loaded = {}
    if type(loaded) is not dict:
        raise ValueError("front matter must be a mapping")

    direct_fields: list[tuple[str, str]] = []
    values_by_name: dict[str, str] = {}
    for name, value in loaded.items():
        if type(name) is not str or name not in DIRECT_FIELD_NAMES:
            raise ValueError("front matter contains an unknown field")
        if type(value) is not str or not value.strip():
            raise ValueError("front matter values must be nonempty strings")
        values_by_name[name] = value
        direct_fields.append((name, value))

    if (
        "first_name" not in values_by_name
        and "last_name" not in values_by_name
        and "full_name" in values_by_name
    ):
        name_parts = values_by_name["full_name"].strip().split(maxsplit=1)
        direct_fields.append(("first_name", name_parts[0]))
        if len(name_parts) == 2:
            direct_fields.append(("last_name", name_parts[1]))

    narrative = "".join(lines[closing_index + 1 :])
    return PersonalInformation(tuple(direct_fields), narrative)


async def _close_uploads(uploads: Sequence[UploadFile]) -> None:
    first_error: BaseException | None = None
    seen: set[int] = set()
    for upload in uploads:
        identity = id(upload)
        if identity in seen:
            continue
        seen.add(identity)
        try:
            await upload.close()
        except BaseException as error:
            if first_error is None:
                first_error = error
    if first_error is not None:
        raise first_error


def retry_pending_cleanup() -> bool:
    for path in tuple(_PENDING_CLEANUP):
        try:
            remove_session_artifacts(path)
        except Exception:
            continue
        _PENDING_CLEANUP.discard(path)
    return not _PENDING_CLEANUP


def cleanup_orphaned_session_artifacts(root: Path) -> bool:
    """Remove UUID-named session trees left without an in-memory owner."""

    try:
        root_descriptor, absolute_root = _open_directory_chain(root, create=False)
    except FileNotFoundError:
        return retry_pending_cleanup()
    candidates: list[Path] = []
    cleanup_ok = True
    try:
        with os.scandir(root_descriptor) as entries:
            for entry in entries:
                try:
                    session_id = UUID(entry.name)
                except ValueError:
                    continue
                if str(session_id) != entry.name:
                    continue
                candidate = absolute_root / entry.name
                if entry.is_dir(follow_symlinks=False):
                    candidates.append(candidate)
                    continue
                try:
                    os.unlink(entry.name, dir_fd=root_descriptor)
                except FileNotFoundError:
                    continue
                except OSError:
                    _PENDING_CLEANUP.add(candidate)
                    cleanup_ok = False
    finally:
        os.close(root_descriptor)
    for candidate in candidates:
        cleanup_ok = _best_effort_remove(candidate) and cleanup_ok
    return retry_pending_cleanup() and cleanup_ok


def _best_effort_remove(path: Path | None) -> bool:
    if path is None:
        return True
    try:
        remove_session_artifacts(path)
    except Exception:
        _PENDING_CLEANUP.add(path)
        return False
    _PENDING_CLEANUP.discard(path)
    return True


def cleanup_session_artifacts(path: Path) -> bool:
    """Attempt cleanup and retain a retry obligation if the filesystem refuses it."""

    return _best_effort_remove(path)


async def store_uploads(
    root: Path,
    session_id: UUID | str,
    personal_information: UploadFile,
    resume: UploadFile,
    resume_source: UploadFile,
    contexts: Sequence[UploadFile],
    anecdotes: Sequence[UploadFile],
) -> StoredCandidateArtifacts:
    retry_pending_cleanup()
    context_uploads = tuple(contexts)
    anecdote_uploads = tuple(anecdotes)
    all_uploads = (
        personal_information,
        resume,
        resume_source,
        *context_uploads,
        *anecdote_uploads,
    )
    session_directory: Path | None = None
    session_descriptor: int | None = None

    try:
        try:
            if (
                len(context_uploads) > APPLICATION_CONTEXT_MAX_COUNT
                or len(anecdote_uploads) > APPLICATION_ANECDOTE_MAX_COUNT
            ):
                raise ValueError("too many uploads")

            session_descriptor, session_directory = _create_session_directory(
                Path(root), session_id
            )

            personal_upload, _, personal_markdown = await _store_upload(
                personal_information,
                directory_descriptor=session_descriptor,
                session_directory=session_directory,
                allowed_suffixes=frozenset({".md"}),
                maximum_bytes=APPLICATION_PROFILE_MAX_BYTES,
                decode_utf8=True,
                retain_text=True,
            )
            if personal_markdown is None:
                raise RuntimeError("personal information text was not retained")
            personal = _parse_personal_information(personal_markdown)

            stored_resume, _, _ = await _store_upload(
                resume,
                directory_descriptor=session_descriptor,
                session_directory=session_directory,
                allowed_suffixes=frozenset({".pdf"}),
                maximum_bytes=APPLICATION_RESUME_MAX_BYTES,
                decode_utf8=False,
                require_pdf_magic=True,
            )
            stored_resume_source, resume_source_size, _ = await _store_upload(
                resume_source,
                directory_descriptor=session_descriptor,
                session_directory=session_directory,
                allowed_suffixes=frozenset({".tex"}),
                maximum_bytes=APPLICATION_RESUME_SOURCE_MAX_BYTES,
                decode_utf8=True,
            )
            if resume_source_size < 1:
                raise ValueError("resume source is empty")

            stored_contexts: list[StoredUpload] = []
            context_total = 0
            for upload in context_uploads:
                stored, size, _ = await _store_upload(
                    upload,
                    directory_descriptor=session_descriptor,
                    session_directory=session_directory,
                    allowed_suffixes=frozenset({".md", ".txt"}),
                    maximum_bytes=min(
                        APPLICATION_CONTEXT_MAX_BYTES,
                        APPLICATION_CONTEXT_TOTAL_MAX_BYTES - context_total,
                    ),
                    decode_utf8=True,
                )
                context_total += size
                stored_contexts.append(stored)

            stored_anecdotes: list[StoredUpload] = []
            anecdote_total = 0
            for upload in anecdote_uploads:
                stored, size, _ = await _store_upload(
                    upload,
                    directory_descriptor=session_descriptor,
                    session_directory=session_directory,
                    allowed_suffixes=frozenset({".md", ".txt"}),
                    maximum_bytes=min(
                        APPLICATION_ANECDOTE_MAX_BYTES,
                        APPLICATION_ANECDOTE_TOTAL_MAX_BYTES - anecdote_total,
                    ),
                    decode_utf8=True,
                )
                anecdote_total += size
                stored_anecdotes.append(stored)

            result = StoredCandidateArtifacts(
                session_directory=session_directory,
                personal_upload=personal_upload,
                resume=stored_resume,
                resume_source=stored_resume_source,
                contexts=tuple(stored_contexts),
                anecdotes=tuple(stored_anecdotes),
                personal=personal,
            )
        finally:
            active_error = sys.exception()
            descriptor_error: BaseException | None = None
            if session_descriptor is not None:
                try:
                    os.close(session_descriptor)
                except BaseException as error:
                    descriptor_error = error
                session_descriptor = None
            try:
                await _close_uploads(all_uploads)
            except asyncio.CancelledError:
                raise
            except BaseException:
                if active_error is None and descriptor_error is None:
                    raise
            if active_error is None and descriptor_error is not None:
                raise descriptor_error
    except asyncio.CancelledError:
        _best_effort_remove(session_directory)
        raise
    except Exception:
        _best_effort_remove(session_directory)
        raise _invalid_request() from None
    except BaseException:
        _best_effort_remove(session_directory)
        raise

    return result


__all__ = [
    "PersonalInformation",
    "StoredCandidateArtifacts",
    "StoredUpload",
    "create_session_artifact_directory",
    "cleanup_orphaned_session_artifacts",
    "cleanup_session_artifacts",
    "remove_session_artifacts",
    "retry_pending_cleanup",
    "store_uploads",
]
