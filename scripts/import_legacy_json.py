from __future__ import annotations

import argparse
import json
from pathlib import Path

from supabase_backend import get_team_by_slug_or_name, save_calendar_items, save_games, save_players, save_settings


def load_json(path: Path, default):
    if not path.exists():
        return default
    with path.open() as handle:
        data = json.load(handle)
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description="Import the legacy JSON files into Supabase-backed tables.")
    parser.add_argument("--team", required=True, help="Team slug or exact team name.")
    parser.add_argument("--data-dir", default="data", help="Directory containing legacy JSON files.")
    args = parser.parse_args()

    team = get_team_by_slug_or_name(args.team)
    if not team:
        raise SystemExit(f"Unknown team: {args.team}")

    data_dir = Path(args.data_dir)
    players = load_json(data_dir / "players.json", [])
    games = load_json(data_dir / "games.json", [])
    settings = load_json(data_dir / "settings.json", {})
    calendar_raw = load_json(data_dir / "calendar.json", {"items": []})
    calendar_items = calendar_raw.get("items", []) if isinstance(calendar_raw, dict) else calendar_raw

    save_players(int(team["id"]), players)
    save_games(int(team["id"]), games)
    save_settings(int(team["id"]), settings if isinstance(settings, dict) else {})
    save_calendar_items(int(team["id"]), calendar_items if isinstance(calendar_items, list) else [])

    print(f"Imported legacy data into team '{team['name']}' ({team['slug']}).")


if __name__ == "__main__":
    main()
