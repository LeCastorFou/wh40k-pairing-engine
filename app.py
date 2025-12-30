from flask import Flask, render_template, request, jsonify, send_from_directory,send_file
from flask import session, redirect, url_for
from functools import wraps
from pathlib import Path
import json
from datetime import datetime
import os 
import re
import itertools
import math
from io import BytesIO
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


app = Flask(__name__)

app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-me")

TEAM_PASSWORD = os.getenv("TEAM_PASSWORD", "embu")

def slugify(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "team"

TEAM_NAME = os.getenv("TEAM_NAME", "Embuscade")
TEAM_SLUG = os.getenv("TEAM_SLUG", slugify(TEAM_NAME))

# In container we always use /app/data (mounted from host)
DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

PLAYERS_FILE = DATA_DIR / "players.json"
GAMES_FILE = DATA_DIR / "games.json"

ALLOWED_MATRIX_STATES = {
    "GAMBLE", "UNKNOWN", "EASY", "WIN",
    "S_WIN", "S_LOOSE", "LOOSE", "HELP"
}


STATE_TO_SCORE = {
    "HELP": 3.0,
    "LOOSE": 6.5,
    "S_LOOSE": 9.0,
    "S_WIN": 11.0,
    "WIN": 13.5,
    "EASY": 16.0,
    "UNKNOWN": 10.0,
    "GAMBLE": 10.0,
}

def default_list_text(player: dict):
    lists = player.get("lists") or []
    idx = player.get("default_index")
    if isinstance(idx, int) and 0 <= idx < len(lists):
        return lists[idx]
    return None

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

    roster = game.get("roster", [])
    roster_locked = isinstance(roster, list) and len(roster) == 8

    matrix = game.get("matrix", {})

    return jsonify({
        "game": {
            "id": game.get("id"),
            "opponent_name": game.get("opponent_name"),
            "armies": game.get("armies", []),
            "created_at": game.get("created_at"),
            "comment": game.get("comment", ""),
        },
        "roster_locked": roster_locked,
        "players": roster if roster_locked else [],
        "all_players": load_players() if not roster_locked else [],
        "matrix": matrix
    })





@app.route("/api/games/<int:game_id>/matrix", methods=["POST"])
@login_required
def api_save_game_matrix(game_id):
    
    games = load_games()
    game = next((g for g in games if g.get("id") == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    roster = game.get("roster", [])
    roster_ids = {p.get("player_id") for p in roster if isinstance(p, dict)}

    if len(roster_ids) != 8:
        return jsonify({"error": "Roster not locked yet for this game"}), 400
    
    payload = request.get_json(silent=True) or {}
    entries = payload.get("entries", [])
    comment = payload.get("comment", "")
    if not isinstance(entries, list):
        return jsonify({"error": "entries must be a list"}), 400
    if comment is None:
        comment = ""
    if not isinstance(comment, str):
        return jsonify({"error": "comment must be a string"}), 400

    new_matrix = {}

    for entry in entries:
        player_id = entry.get("player_id")
        army_index = entry.get("army_index")
        value = entry.get("value")
        
        if player_id not in roster_ids:
            return jsonify({"error": f"player_id {player_id} is not in this game's roster"}), 400

        if not isinstance(player_id, int) or not isinstance(army_index, int):
            return jsonify({"error": "player_id and army_index must be integers"}), 400
        if value not in ALLOWED_MATRIX_STATES:
            return jsonify({"error": f"Invalid state {value}"}), 400

        key = f"{player_id}-{army_index}"
        new_matrix[key] = value

    game["matrix"] = new_matrix
    game["comment"] = comment.strip()
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
        
        real_score = p.get("real_score")
        if real_score is not None:
            if not isinstance(real_score, int) or not (0 <= real_score <= 20):
                return jsonify({"error": "real_score must be an integer between 0 and 20"}), 400


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



@app.route("/api/games/<int:game_id>/optimize", methods=["GET"])
def api_optimize_pairing(game_id):
    games = load_games()
    game = next((g for g in games if g.get("id") == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    # Only active players (same logic as your matrix API)
    all_players = load_players()
    roster_ids = game.get("player_ids") or []

    by_id = {p.get("id"): p for p in all_players if isinstance(p, dict)}
    players = [by_id.get(pid) for pid in roster_ids]
    players = [p for p in players if p is not None]

    armies = game.get("armies", [])
    matrix = game.get("matrix", {})  # key "playerId-armyIndex" -> state

    # Need exactly 8 and 8 for pairing optimization
    if len(players) != 8:
        return jsonify({"error": f"Need exactly 8 active players (found {len(players)})"}), 400
    if len(armies) != 8:
        return jsonify({"error": f"Need exactly 8 opponent codex (found {len(armies)})"}), 400

    # Build score table score[i][j]
    score = []
    missing = []
    for i, p in enumerate(players):
        row = []
        for j in range(8):
            key = f"{p['id']}-{j}"
            state = matrix.get(key)
            val = STATE_TO_SCORE.get(state)
            if val is None:
                missing.append({"player_id": p["id"], "army_index": j})
                val = -9999.0  # hard-penalize missing cells
            row.append(val)
        score.append(row)

    if missing:
        return jsonify({
            "error": "Matrix incomplete: some cells are not filled",
            "missing": missing
        }), 400

    # brute force best assignments
    best = []
    for perm in itertools.permutations(range(8)):  # perm[i] = army assigned to player i
        total = 0.0
        for i in range(8):
            total += score[i][perm[i]]
        best.append((total, perm))

    best.sort(key=lambda x: x[0], reverse=True)
    top = best[:5]  # top 5 solutions

    def pack_solution(total, perm):
        pairings = []
        for i in range(8):
            p = players[i]
            a_idx = perm[i]
            a = armies[a_idx]
            state = matrix.get(f"{p['id']}-{a_idx}")
            pairings.append({
                "player_id": p["id"],
                "player_name": p.get("name"),
                "army_index": a_idx,
                "faction": a.get("faction"),
                "state": state,
                "expected": STATE_TO_SCORE.get(state, 0.0),
            })
        return {"total_expected": round(total, 1), "pairings": pairings}

    return jsonify({
        "mode": "ideal_assignment",
        "solutions": [pack_solution(t, perm) for (t, perm) in top]
    })

@app.route("/api/games/<int:game_id>/roster", methods=["POST"])
@login_required
def api_set_game_roster(game_id):
    games = load_games()
    game = next((g for g in games if g.get("id") == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    # Don’t allow changes once locked
    if isinstance(game.get("roster"), list) and len(game["roster"]) == 8:
        return jsonify({"error": "Roster already locked for this game"}), 400

    payload = request.get_json(silent=True) or {}
    player_ids = payload.get("player_ids")

    if not isinstance(player_ids, list) or len(player_ids) != 8:
        return jsonify({"error": "You must select exactly 8 players"}), 400
    if len(set(player_ids)) != 8 or not all(isinstance(x, int) for x in player_ids):
        return jsonify({"error": "Invalid player_ids"}), 400

    players = load_players()
    by_id = {p.get("id"): p for p in players if isinstance(p, dict) and isinstance(p.get("id"), int)}

    missing = [pid for pid in player_ids if pid not in by_id]
    if missing:
        return jsonify({"error": f"Unknown player ids: {missing}"}), 400

    # ✅ SNAPSHOT roster (player + list)
    roster = []
    for pid in player_ids:
        p = by_id[pid]
        roster.append({
            "player_id": pid,
            "player_name": p.get("name") or f"Player {pid}",
            "list_text": default_list_text(p) or "No default list"
        })

    # ✅ Lock roster + reset per-game state
    game["roster"] = roster
    game["player_ids"] = player_ids  # optional (keep for compatibility)
    game["matrix"] = {}
    game["pairings"] = []
    save_games(games)

    return jsonify({"status": "ok", "roster": roster})


@app.route("/report")
@login_required
def report_page():
    return render_template("report.html")


@app.route("/api/report", methods=["GET"])
@login_required
def api_report():
    games = load_games()
    players = load_players()
    by_id = {p.get("id"): p for p in players if isinstance(p, dict)}

    # Expected score mapping (same as your JS)
    STATE_TO_EXPECTED = {
        "HELP": 3.0,
        "LOOSE": 6.5,
        "S_LOOSE": 9.0,
        "S_WIN": 11.0,
        "WIN": 13.5,
        "EASY": 16.0,
        "UNKNOWN": 10.0,
        "GAMBLE": 10.0,
    }

    # Aggregate per player
    stats = {}  # pid -> dict

    def ensure(pid):
        if pid not in stats:
            p = by_id.get(pid, {})
            stats[pid] = {
                "player_id": pid,
                "name": p.get("name") or f"Player {pid}",
                "games_played": 0,
                "sum_real": 0.0,
                "sum_delta": 0.0,
                "delta_count": 0,
                "details": []  # per game detail (optional but nice)
            }
        return stats[pid]

    # Iterate all games, all pairings with real_score
    for g in games:
        gid = g.get("id")
        opp = g.get("opponent_name") or "Unknown"
        scenario = g.get("scenario")
        matrix = g.get("matrix") or {}
        armies = g.get("armies") or []
        pairings = g.get("pairings") or []

        for pr in pairings:
            pid = pr.get("player_id")
            aidx = pr.get("army_index")
            real = pr.get("real_score")

            if not isinstance(pid, int):
                continue
            if not isinstance(real, (int, float)):
                continue

            row = ensure(pid)
            row["games_played"] += 1
            row["sum_real"] += float(real)

            # expected from matrix state
            expected = None
            state = None
            if isinstance(aidx, int):
                state = matrix.get(f"{pid}-{aidx}")
                expected = STATE_TO_EXPECTED.get(state) if state else None

            if isinstance(expected, (int, float)):
                d = float(real) - float(expected)
                row["sum_delta"] += d
                row["delta_count"] += 1
            else:
                d = None

            faction = None
            if isinstance(aidx, int) and 0 <= aidx < len(armies):
                faction = armies[aidx].get("faction")

            row["details"].append({
                "game_id": gid,
                "opponent": opp,
                "game_no": pr.get("game_no"),
                "faction": faction,
                "scenario": scenario,
                "real_score": real,
                "state": state,
                "expected": expected,
                "delta": d,
            })

    # Build final rows
    rows = []
    for pid, r in stats.items():
        avg_real = (r["sum_real"] / r["games_played"]) if r["games_played"] else None
        avg_delta = (r["sum_delta"] / r["delta_count"]) if r["delta_count"] else None
        rows.append({
            "player_id": pid,
            "name": r["name"],
            "games_played": r["games_played"],
            "avg_score": avg_real,
            "avg_delta": avg_delta,
            "details": r["details"],
        })

    # Sort default: best avg_score
    rows.sort(key=lambda x: (x["avg_score"] is None, -(x["avg_score"] or 0), x["name"].lower()))

    return jsonify({
        "players": rows,
        "games_count": len(games)
    })


@app.route("/players/<int:player_id>")
@login_required
def player_detail_page(player_id):
    return render_template("player_detail.html", player_id=player_id)

@app.route("/api/players/<int:player_id>", methods=["GET"])
@login_required
def api_get_player(player_id):
    players = load_players()
    p = next((x for x in players if x.get("id") == player_id), None)
    if not p:
        return jsonify({"error": "Player not found"}), 404
    # ensure fields exist
    p.setdefault("lists", [])
    p.setdefault("default_index", None)
    p.setdefault("active", False)
    p.setdefault("match_history", [])
    return jsonify(p)


@app.route("/api/players/<int:player_id>/matches", methods=["POST"])
@login_required
def api_add_player_match(player_id):
    payload = request.get_json(silent=True) or {}

    faction = (payload.get("faction") or "").strip()
    result = (payload.get("result") or "").strip().upper()  # WIN/DRAW/LOSS
    opponent_level = payload.get("opponent_level")
    comment = (payload.get("comment") or "").strip()

    if not faction:
        return jsonify({"error": "Faction is required"}), 400
    if result not in {"WIN", "DRAW", "LOSS"}:
        return jsonify({"error": "Result must be WIN, DRAW or LOSS"}), 400
    if opponent_level is None:
        return jsonify({"error": "Opponent level is required"}), 400
    try:
        opponent_level = int(opponent_level)
    except Exception:
        return jsonify({"error": "Opponent level must be an integer"}), 400
    if opponent_level < 1 or opponent_level > 5:
        return jsonify({"error": "Opponent level must be 1..5"}), 400

    players = load_players()
    p = next((x for x in players if x.get("id") == player_id), None)
    if not p:
        return jsonify({"error": "Player not found"}), 404

    p.setdefault("match_history", [])
    existing_ids = [m.get("id") for m in p["match_history"] if isinstance(m, dict) and "id" in m]
    next_id = (max(existing_ids) + 1) if existing_ids else 1

    entry = {
        "id": next_id,
        "date": datetime.now().isoformat(timespec="seconds"),
        "faction": faction,
        "result": result,
        "opponent_level": opponent_level,
        "comment": comment
    }
    p["match_history"].append(entry)
    save_players(players)

    return jsonify({"status": "ok", "match": entry}), 201


@app.route("/api/players/<int:player_id>/matches/<int:match_id>", methods=["DELETE"])
@login_required
def api_delete_player_match(player_id, match_id):
    players = load_players()
    p = next((x for x in players if x.get("id") == player_id), None)
    if not p:
        return jsonify({"error": "Player not found"}), 404

    hist = p.get("match_history") or []
    new_hist = [m for m in hist if m.get("id") != match_id]
    if len(new_hist) == len(hist):
        return jsonify({"error": "Match not found"}), 404

    p["match_history"] = new_hist
    save_players(players)
    return jsonify({"status": "ok"})

@app.route("/api/games/<int:game_id>/lists_pdf", methods=["GET"])
@login_required
def api_game_lists_pdf(game_id):
    games = load_games()
    game = next((g for g in games if g.get("id") == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    all_players = load_players()
    roster_ids = game.get("player_ids") or []

    # Map id -> player (global)
    by_id = {p.get("id"): p for p in all_players if isinstance(p, dict)}

    # Current roster players
    roster_players = [by_id.get(pid) for pid in roster_ids if by_id.get(pid)]

    if not roster_players:
        return jsonify({"error": "No roster defined for this game"}), 400

    # Helper to get default list text (full text, not truncated)
    def get_default_list_text(player):
        # If at some point you store a frozen snapshot, prefer that:
        snap_text = player.get("list_text")
        if isinstance(snap_text, str) and snap_text.strip():
            return snap_text.strip()

        lists = player.get("lists") or []
        idx = player.get("default_index")
        if isinstance(idx, int) and 0 <= idx < len(lists):
            return (lists[idx] or "").strip()

        # Fallback: first list if exists
        if lists:
            return (lists[0] or "").strip()

        return "(No list text)"

    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4

    y = height - 40  # start position
    left_margin = 40
    line_height = 12

    # Title
    c.setFont("Helvetica-Bold", 14)
    c.drawString(left_margin, y, f"Game #{game.get('id')} – {game.get('opponent_name') or 'Opponent'}")
    y -= 24

    for p in roster_players:
        name = p.get("name") or f"Player {p.get('id')}"
        list_text = get_default_list_text(p)

        # Page break if needed
        if y < 80:
            c.showPage()
            y = height - 40
            c.setFont("Helvetica-Bold", 14)
            c.drawString(left_margin, y, f"Game #{game.get('id')} – {game.get('opponent_name') or 'Opponent'}")
            y -= 24

        # Player header
        c.setFont("Helvetica-Bold", 12)
        c.drawString(left_margin, y, name)
        y -= 16

        # List text (monospace style)
        c.setFont("Courier", 9)

        # Simple word-wrap
        max_chars = 95  # rough width
        for raw_line in list_text.splitlines() or [""]:
            line = raw_line if raw_line.strip() != "" else " "
            while len(line) > max_chars:
                segment = line[:max_chars]
                c.drawString(left_margin, y, segment)
                y -= line_height
                line = line[max_chars:]
                if y < 40:
                    c.showPage()
                    y = height - 40
                    c.setFont("Courier", 9)
            c.drawString(left_margin, y, line)
            y -= line_height
            if y < 40:
                c.showPage()
                y = height - 40
                c.setFont("Courier", 9)

        # Spacer between players
        y -= 10

    c.showPage()
    c.save()
    buffer.seek(0)

    filename = f"game_{game_id}_lists.pdf"
    return send_file(
        buffer,
        as_attachment=True,
        download_name=filename,
        mimetype="application/pdf"
    )


if __name__ == "__main__":
    app.run(debug=True)
