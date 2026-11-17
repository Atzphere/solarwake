"""Atomic JSON persistence: one schedule and one scheduler process for the MVP."""

import json
from pathlib import Path
from .model import Settings


class Store:
    def __init__(self, directory: str = "/data"):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.directory / "settings.json"
        self.state_path = self.directory / "runtime.json"
        self.settings = (Settings.model_validate_json(self.settings_path.read_text())
                         if self.settings_path.exists() else Settings())
        self.runtime = (json.loads(self.state_path.read_text()) if self.state_path.exists()
                        else {"last_run": None, "last_phase": None,
                              "last_pct": None, "last_sent_at": None,
                              "skipped_run": None})

    @staticmethod
    def _write(path: Path, value: dict) -> None:
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(json.dumps(value, indent=2) + "\n")
        temp.replace(path)

    def save_settings(self, settings: Settings) -> None:
        self._write(self.settings_path, settings.model_dump())
        self.settings = settings

    def save_runtime(self) -> None:
        self._write(self.state_path, self.runtime)
