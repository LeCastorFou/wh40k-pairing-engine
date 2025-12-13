from flask import Flask, render_template, request, jsonify, send_from_directory
from flask import session, redirect, url_for
from functools import wraps
from pathlib import Path
import json
from datetime import datetime
import os 
import re

app = Flask(__name__)

app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-me")

TEAM_NAME = os.getenv("TEAM_NAME", "Team")
TEAM_PASSWORD = os.getenv("TEAM_PASSWORD", "password")

DATA_DIR = Path("data")
PLAYERS_FILE = DATA_DIR / "players.json"
GAMES_FILE = DATA_DIR / "games.json" 


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("index"))
        return view(*args, **kwargs)
    return wrapped

def load_games():
    if not GAMES_FILE.exists():
        return []
    try:
        with GAMES_FILE.open() as f:
            data = json.load(f)
            if isinstance(data, list):
                return data
            return []
    except json.JSONDecodeError:
        return []


def save_games(games):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with GAMES_FILE.open("w") as f:
        json.dump(games, f, indent=2)


def next_game_id(games):
    ids = [g.get("id") for g in games if isinstance(g, dict) and "id" in g]
    if not ids:
        return 1
    return max(ids) + 1

def load_players():
    if not PLAYERS_FILE.exists():
        return []
    try:
        with PLAYERS_FILE.open() as f:
            data = json.load(f)
            if isinstance(data, list):
                data = normalize_players(data)
                # optional: save back once to persist "active" field
                save_players(data)
                return data
            return []
    except json.JSONDecodeError:
        return []

def normalize_players(players):
    # ensure each player has "active"
    # default: first 8 players active, rest inactive (only if missing field)
    active_count = 0
    for p in players:
        if not isinstance(p, dict):
            continue
        if "active" not in p:
            if active_count < 8:
                p["active"] = True
                active_count += 1
            else:
                p["active"] = False
        else:
            if p.get("active") is True:
                active_count += 1
    return players


def save_players(players):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with PLAYERS_FILE.open("w") as f:
        json.dump(players, f, indent=2)


def next_player_id(players):
    """Compute next player id, even if some entries are odd."""
    ids = [p.get("id") for p in players if isinstance(p, dict) and "id" in p]
    if not ids:
        return 1
    return max(ids) + 1


@app.route("/api/login", methods=["POST"])
def api_login():
    payload = request.get_json(silent=True) or {}
    password = (payload.get("password") or "").strip()

    if password != TEAM_PASSWORD:
        return jsonify({"error": "Invalid password"}), 401

    session["logged_in"] = True
    return jsonify({"status": "ok"})

@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"status": "ok"})


@app.route("/")
def index():
    # Intro page
    return render_template("index.html",
        team_name=TEAM_NAME,
        logged_in=bool(session.get("logged_in"))
        )


@app.route("/players")
@login_required
def players_page():
    # Page with UI to manage players
    return render_template("players.html")


# ---------- API: Players CRUD ----------

@app.route("/api/players", methods=["GET"])
@login_required
def api_get_players():
    players = load_players()
    return jsonify(players)


@app.route("/api/players", methods=["POST"])
@login_required
def api_add_player():
    try:
        data = request.get_json(silent=True) or {}
        name = data.get("name", "").strip()
        if not name:
            return jsonify({"error": "Name is required"}), 400

        players = load_players()
        new_player = {
            "id": next_player_id(players),
            "name": name,
            "lists": [],
            "default_index": None,
            "active": False,   # NEW
        }
        players.append(new_player)
        save_players(players)
        return jsonify(new_player), 201

    except Exception as e:
        # In dev mode, this will help debug in the browser
        print("Error in /api/players POST:", e)
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
    
@app.route("/api/players/<int:player_id>/active", methods=["POST"])
@login_required
def api_set_player_active(player_id):
    payload = request.get_json(silent=True) or {}
    active = payload.get("active")
    if not isinstance(active, bool):
        return jsonify({"error": "active must be boolean"}), 400

    players = load_players()

    # count currently active excluding this player
    active_others = sum(1 for p in players if p.get("id") != player_id and p.get("active") is True)

    if active and active_others >= 8:
        return jsonify({"error": "You can only activate 8 players."}), 400

    for p in players:
        if p.get("id") == player_id:
            p["active"] = active
            save_players(players)
            return jsonify(p)

    return jsonify({"error": "Player not found"}), 404


@app.route("/api/players/<int:player_id>", methods=["DELETE"])
@login_required
def api_delete_player(player_id):
    players = load_players()
    players = [p for p in players if p["id"] != player_id]
    save_players(players)
    return jsonify({"status": "ok"})


# ---------- API: Lists per player ----------

@app.route("/api/players/<int:player_id>/lists", methods=["POST"])
@login_required
def api_add_list(player_id):
    data = request.get_json()
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"error": "List text is required"}), 400

    players = load_players()
    for p in players:
        if p["id"] == player_id:
            p["lists"].append(text)
            # if it's the first list, make it default
            if p["default_index"] is None:
                p["default_index"] = 0
            save_players(players)
            return jsonify(p)
    return jsonify({"error": "Player not found"}), 404


@app.route("/api/players/<int:player_id>/lists/<int:list_index>", methods=["DELETE"])
@login_required
def api_delete_list(player_id, list_index):
    players = load_players()
    for p in players:
        if p["id"] == player_id:
            if 0 <= list_index < len(p["lists"]):
                p["lists"].pop(list_index)
                # adjust default_index
                if p["default_index"] is not None:
                    if list_index == p["default_index"]:
                        p["default_index"] = 0 if p["lists"] else None
                    elif list_index < p["default_index"]:
                        p["default_index"] -= 1
                save_players(players)
                return jsonify(p)
            return jsonify({"error": "List index out of range"}), 400
    return jsonify({"error": "Player not found"}), 404


@app.route("/api/players/<int:player_id>/default_list", methods=["POST"])
@login_required
def api_set_default_list(player_id):
    data = request.get_json()
    index = data.get("index")
    if index is None:
        return jsonify({"error": "Index is required"}), 400

    players = load_players()
    for p in players:
        if p["id"] == player_id:
            if not (0 <= index < len(p["lists"])):
                return jsonify({"error": "Index out of range"}), 400
            p["default_index"] = index
            save_players(players)
            return jsonify(p)
    return jsonify({"error": "Player not found"}), 404


@app.route("/games/new")
@login_required
def new_game_page():
    return render_template("game_new.html")

@app.route("/api/games", methods=["POST"])
@login_required
def api_create_game():
    data = request.get_json(silent=True) or {}
    opponent_name = (data.get("opponent_name") or "").strip()
    armies = data.get("armies") or []

    if not opponent_name:
        return jsonify({"error": "Opponent name is required"}), 400

    # Basic validation: 1–8 entries, each with faction + list text
    if not (1 <= len(armies) <= 8):
        return jsonify({"error": "You must define between 1 and 8 armies"}), 400

    seen_factions = set()
    for a in armies:
        faction = (a.get("faction") or "").strip()
        lst = (a.get("list") or "").strip()
        if not faction or not lst:
            return jsonify({"error": "Each army needs a faction and a list text"}), 400
        if faction in seen_factions:
            return jsonify({"error": "Each faction must be unique (no duplicates)"}), 400
        seen_factions.add(faction)

    games = load_games()
    new_game = {
        "id": next_game_id(games),
        "opponent_name": opponent_name,
        "armies": armies,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    games.append(new_game)
    save_games(games)
    return jsonify(new_game), 201


@app.route("/games")
@login_required
def games_list_page():
    return render_template("game_list.html")


@app.route("/api/games", methods=["GET"])
@login_required
def api_get_games():
    games = load_games()
    # Sort newest first
    games_sorted = sorted(games, key=lambda g: g.get("created_at", ""), reverse=True)
    return jsonify(games_sorted)

@app.route("/api/games/<int:game_id>", methods=["DELETE"])
@login_required
def api_delete_game(game_id):
    games = load_games()
    new_games = [g for g in games if g.get("id") != game_id]
    if len(new_games) == len(games):
        return jsonify({"error": "Game not found"}), 404
    save_games(new_games)
    return jsonify({"status": "ok"})

@app.route("/games/<int:game_id>/matrix")
@login_required
def game_matrix_page(game_id):
    # We just pass game_id; the JS will fetch details via API
    return render_template("game_matrix.html", game_id=game_id)


@app.route("/api/games/<int:game_id>/matrix", methods=["GET"])
@login_required
def api_get_game_matrix(game_id):
    games = load_games()
    game = next((g for g in games if g.get("id") == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    players = [p for p in load_players() if p.get("active") is True]
    matrix = game.get("matrix", {})

    return jsonify({
        "game": {
            "id": game.get("id"),
            "opponent_name": game.get("opponent_name"),
            "armies": game.get("armies", []),
            "created_at": game.get("created_at"),
        },
        "players": players,
        "matrix": matrix
    })


ALLOWED_MATRIX_STATES = {
    "GAMBLE", "UNKNOWN", "EASY", "WIN",
    "S_WIN", "S_LOOSE", "LOOSE", "HELP"
}

@app.route("/api/games/<int:game_id>/matrix", methods=["POST"])
@login_required
def api_save_game_matrix(game_id):
    games = load_games()
    game = next((g for g in games if g.get("id") == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    payload = request.get_json(silent=True) or {}
    entries = payload.get("entries", [])
    if not isinstance(entries, list):
        return jsonify({"error": "entries must be a list"}), 400

    new_matrix = {}

    for entry in entries:
        player_id = entry.get("player_id")
        army_index = entry.get("army_index")
        value = entry.get("value")

        if not isinstance(player_id, int) or not isinstance(army_index, int):
            return jsonify({"error": "player_id and army_index must be integers"}), 400
        if value not in ALLOWED_MATRIX_STATES:
            return jsonify({"error": f"Invalid state {value}"}), 400

        key = f"{player_id}-{army_index}"
        new_matrix[key] = value

    game["matrix"] = new_matrix
    save_games(games)

    return jsonify({"status": "ok", "matrix": new_matrix})


@app.route("/games/<int:game_id>/fight")
@login_required
def game_fight_page(game_id):
    return render_template("game_fight.html", game_id=game_id)



@app.route("/api/games/<int:game_id>/pairings", methods=["POST"])
@login_required
def api_save_game_pairings(game_id):
    games = load_games()
    game = next((g for g in games if g.get("id") == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    payload = request.get_json(silent=True) or {}

    # ⭐ NEW: global scenario
    scenario = payload.get("scenario")
    if scenario is not None:
        game["scenario"] = scenario

    pairings = payload.get("pairings", [])
    if not isinstance(pairings, list):
        return jsonify({"error": "pairings must be a list"}), 400

    used_players = set()
    used_armies = set()
    used_layouts = set()

    for p in pairings:
        if not isinstance(p, dict):
            return jsonify({"error": "Invalid pairing entry"}), 400

        game_no = p.get("game_no")
        player_id = p.get("player_id")
        army_index = p.get("army_index")
        layout_n = p.get("layout_n")

        # allow empty slots
        if player_id is None or army_index is None:
            continue

        if not isinstance(game_no, int) or not (1 <= game_no <= 8):
            return jsonify({"error": "game_no must be 1..8"}), 400
        if not isinstance(player_id, int) or not isinstance(army_index, int):
            return jsonify({"error": "player_id and army_index must be int"}), 400
        if not isinstance(layout_n, int) or layout_n <= 0:
            return jsonify({"error": "layout_n must be a positive integer"}), 400

        if player_id in used_players:
            return jsonify({"error": "A player is used more than once"}), 400
        if army_index in used_armies:
            return jsonify({"error": "An opponent list is used more than once"}), 400
        if layout_n in used_layouts:
            return jsonify({"error": "A layout number is used more than once"}), 400

        used_players.add(player_id)
        used_armies.add(army_index)
        used_layouts.add(layout_n)

    game["pairings"] = pairings
    save_games(games)

    return jsonify({
        "status": "ok",
        "scenario": game.get("scenario"),
        "pairings": pairings
    })

@app.route("/api/games/<int:game_id>/pairings", methods=["GET"])
@login_required
def api_get_game_pairings(game_id):
    games = load_games()
    game = next((g for g in games if g.get("id") == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    return jsonify({
        "scenario": game.get("scenario"),
        "pairings": game.get("pairings", [])
    })


@app.route("/layouts/<path:filename>")
@login_required
def serve_layout(filename):
    # Serves data/HAX.png, etc.
    return send_from_directory(str(DATA_DIR), filename)


SCENARIO_PREFIX = {
    "HAMMER_ANVIL": "HA",
    "SEEK_DESTROY": "SD",
    "CRUCIBLE_BATTLE": "CB",
    "TIPPING_POINTS": "TP",
    "DAWN_OF_WAR": "DOW",
    "SWEEPING_ENGAGEMENT": "SE"  
    }

@app.route("/api/layouts", methods=["GET"])
@login_required
def api_list_layouts():
    """
    Returns:
      {
        "HAMMER_ANVIL": [{"n":1,"file":"HA1.png"}, ...],
        ...
      }
    Only lists files that exist in data/ and match <prefix><number>.png
    """
    out = {k: [] for k in SCENARIO_PREFIX.keys()}

    try:
        files = os.listdir(DATA_DIR)
    except FileNotFoundError:
        files = []

    for scenario, prefix in SCENARIO_PREFIX.items():
        # match like HA1.png / DOW3.png etc.
        rx = re.compile(rf"^{re.escape(prefix)}(\d+)\.png$", re.IGNORECASE)
        matches = []
        for fn in files:
            m = rx.match(fn)
            if m:
                n = int(m.group(1))
                matches.append({"n": n, "file": fn})
        matches.sort(key=lambda x: x["n"])
        out[scenario] = matches

    return jsonify(out)


if __name__ == "__main__":
    app.run(debug=True)
