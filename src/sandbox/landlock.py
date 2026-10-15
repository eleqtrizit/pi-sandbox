#!/usr/bin/env python3
"""
Apply a Landlock filesystem ruleset to this process, then exec a command.

Used by os-sandbox.ts on Linux when bubblewrap cannot create user namespaces
(e.g. Ubuntu 24.04+ AppArmor restrictions). Landlock is allow-only: every path
not granted here is denied for reads, writes and execution. The helper fails
closed: on any error the command is never executed.

Usage::

    landlock.py --probe
    landlock.py [--rw PATH]... [--ro PATH]... -- COMMAND [ARG]...
"""

import ctypes
import os
import stat
import sys

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

EXECUTE = 1 << 0
WRITE_FILE = 1 << 1
READ_FILE = 1 << 2
READ_DIR = 1 << 3
ABI1_ALL = (1 << 13) - 1
REFER = 1 << 13
TRUNCATE = 1 << 14
IOCTL_DEV = 1 << 15
FILE_ONLY = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV
READ_ONLY = EXECUTE | READ_FILE | READ_DIR

EXIT_SANDBOX_ERROR = 126
EXIT_EXEC_ERROR = 127


class RulesetAttr(ctypes.Structure):
    """First field of ``struct landlock_ruleset_attr`` (the kernel accepts a prefix)."""

    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    """``struct landlock_path_beneath_attr`` (packed in the kernel ABI)."""

    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class LandlockError(Exception):
    """Raised when Landlock is unavailable or a Landlock syscall fails."""


_libc = ctypes.CDLL(None, use_errno=True)
_libc.syscall.restype = ctypes.c_long


def _syscall(number: int, *args: object) -> int:
    """
    Invoke a raw syscall and raise on failure.

    :param number: The syscall number
    :type number: int
    :param args: ctypes-compatible syscall arguments
    :type args: object
    :return: The non-negative syscall result
    :rtype: int
    :raises LandlockError: If the syscall returns an error
    """
    ret = _libc.syscall(ctypes.c_long(number), *args)
    if ret < 0:
        raise LandlockError(f"syscall {number} failed: {os.strerror(ctypes.get_errno())}")
    return int(ret)


def abi_version() -> int:
    """
    Query the Landlock ABI version supported by the running kernel.

    :return: The ABI version (>= 1)
    :rtype: int
    :raises LandlockError: If Landlock is not supported or disabled
    """
    return _syscall(SYS_LANDLOCK_CREATE_RULESET, None, ctypes.c_size_t(0),
                    ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION))


def handled_rights(abi: int) -> int:
    """
    Compute every filesystem right the given ABI can restrict.

    :param abi: The Landlock ABI version
    :type abi: int
    :return: Bitmask of handled filesystem access rights
    :rtype: int
    """
    rights = ABI1_ALL
    if abi >= 2:
        rights |= REFER
    if abi >= 3:
        rights |= TRUNCATE
    if abi >= 5:
        rights |= IOCTL_DEV
    return rights


def add_path(ruleset_fd: int, path: str, access: int, handled: int) -> None:
    """
    Grant ``access`` beneath ``path``. Missing paths grant nothing.

    :param ruleset_fd: The Landlock ruleset file descriptor
    :type ruleset_fd: int
    :param path: The directory or file to allow
    :type path: str
    :param access: Requested access rights
    :type access: int
    :param handled: Rights handled by the ruleset
    :type handled: int
    :raises LandlockError: If the kernel rejects the rule
    """
    try:
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    except OSError:
        return
    try:
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            access &= FILE_ONLY
        attr = PathBeneathAttr(access & handled, fd)
        _syscall(SYS_LANDLOCK_ADD_RULE, ctypes.c_int(ruleset_fd), ctypes.c_int(LANDLOCK_RULE_PATH_BENEATH),
                 ctypes.byref(attr), ctypes.c_uint32(0))
    finally:
        os.close(fd)


def restrict(read_write: list[str], read_only: list[str]) -> None:
    """
    Restrict this process (and future children) to the given paths.

    :param read_write: Paths granted full access
    :type read_write: list[str]
    :param read_only: Paths granted read and execute access
    :type read_only: list[str]
    :raises LandlockError: If any step of the restriction fails
    """
    handled = handled_rights(abi_version())
    attr = RulesetAttr(handled)
    ruleset_fd = _syscall(SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)),
                          ctypes.c_uint32(0))
    try:
        for path in read_write:
            add_path(ruleset_fd, path, handled, handled)
        for path in read_only:
            add_path(ruleset_fd, path, READ_ONLY, handled)
        if _libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            raise LandlockError(f"prctl(NO_NEW_PRIVS) failed: {os.strerror(ctypes.get_errno())}")
        _syscall(SYS_LANDLOCK_RESTRICT_SELF, ctypes.c_int(ruleset_fd), ctypes.c_uint32(0))
    finally:
        os.close(ruleset_fd)


def parse_args(argv: list[str]) -> tuple[list[str], list[str], list[str]]:
    """
    Split ``--rw``/``--ro`` path options from the command after ``--``.

    :param argv: Arguments after the program name
    :type argv: list[str]
    :return: Read-write paths, read-only paths, and the command vector
    :rtype: tuple[list[str], list[str], list[str]]
    :raises ValueError: On unknown options, missing values, or an empty command
    """
    read_write: list[str] = []
    read_only: list[str] = []
    i = 0
    while i < len(argv) and argv[i] != "--":
        flag = argv[i]
        if flag not in ("--rw", "--ro") or i + 1 >= len(argv):
            raise ValueError(f"bad argument: {flag}")
        (read_write if flag == "--rw" else read_only).append(argv[i + 1])
        i += 2
    command = argv[i + 1:]
    if not command:
        raise ValueError("missing command after --")
    return read_write, read_only, command


def main(argv: list[str]) -> int:
    """
    Entry point: probe Landlock, or restrict and exec the command.

    :param argv: Arguments after the program name
    :type argv: list[str]
    :return: Exit status (only returned on failure or probe)
    :rtype: int
    """
    if argv == ["--probe"]:
        try:
            print(abi_version())
        except LandlockError as err:
            print(f"landlock unavailable: {err}", file=sys.stderr)
            return 1
        return 0
    try:
        read_write, read_only, command = parse_args(argv)
        restrict(read_write, read_only)
    except (LandlockError, ValueError) as err:
        print(f"landlock sandbox: {err}", file=sys.stderr)
        return EXIT_SANDBOX_ERROR
    try:
        os.execvp(command[0], command)
    except OSError as err:
        print(f"landlock sandbox: cannot exec {command[0]}: {err}", file=sys.stderr)
    return EXIT_EXEC_ERROR


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
