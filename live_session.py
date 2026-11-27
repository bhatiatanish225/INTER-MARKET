"""Store the dashboard's remembered Microsoft session using Windows DPAPI."""

import ctypes
import json
import os
from ctypes import wintypes
from pathlib import Path
from uuid import uuid4


class DataBlob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.c_void_p)]


def dpapi(data, decrypt=False):
    if os.name != "nt":
        raise OSError("The remembered session requires Windows DPAPI.")
    crypt = ctypes.WinDLL("crypt32.dll", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32.dll", use_last_error=True)
    operation = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    operation.argtypes = [ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob)]
    operation.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    buffer = ctypes.create_string_buffer(data)
    source = DataBlob(len(data), ctypes.addressof(buffer))
    output = DataBlob()
    try:
        # CRYPTPROTECT_UI_FORBIDDEN uses the current user's scope without displaying a prompt.
        if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
            raise ctypes.WinError(ctypes.get_last_error())
        return ctypes.string_at(output.data, output.size)
    finally:
        ctypes.memset(source.data, 0, source.size)
        if output.data:
            ctypes.memset(output.data, 0, output.size)
            kernel.LocalFree(output.data)


class LiveSession:
    def __init__(self, path=None):
        local_app_data = os.environ.get("LOCALAPPDATA")
        self.path = path if path is not None else (
            Path(local_app_data) / "Hertshten" / "IntermarketDashboard" / "live-session.dpapi"
            if local_app_data and os.name == "nt" else None
        )

    def load(self):
        if self.path is None:
            return None
        try:
            saved = json.loads(dpapi(self.path.read_bytes(), decrypt=True))
            if isinstance(saved, dict) and all(isinstance(saved.get(key), str) for key in ("email", "cache")):
                return saved["email"], saved["cache"]
        except (OSError, ValueError):
            pass
        return None

    def save(self, email, cache):
        if self.path is None:
            raise OSError("Local app data is unavailable.")
        payload = dpapi(json.dumps({"email": email, "cache": cache}).encode("utf-8"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        staged = self.path.with_suffix(f".{uuid4().hex}.tmp")
        try:
            staged.write_bytes(payload)
            staged.replace(self.path)
        finally:
            staged.unlink(missing_ok=True)

    def clear(self):
        if self.path is not None:
            self.path.unlink(missing_ok=True)
