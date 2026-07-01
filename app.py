from flask import Flask, render_template, request, jsonify, send_from_directory,send_file
from flask import session, redirect, url_for, g
from functools import lru_cache, wraps
from pathlib import Path
import json
from datetime import datetime
import os 
import re
import itertools
import math
from io import BytesIO
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from dotenv import load_dotenv
from scripts.optimisation import TeamPairingSolver, other_of_pair
from supabase_backend import (
    admin_delete_membership,
    admin_delete_profile,
    admin_delete_team,
    admin_overview,
    admin_rename_profile,
    admin_rename_team,
    create_team,
    ensure_profile,
    get_auth_context,
    get_supabase_client,
    join_team,
    list_public_teams,
    load_calendar_items as db_load_calendar_items,
    load_game as db_load_game,
    load_games as db_load_games,
    load_players as db_load_players,
    load_settings as db_load_settings,
    next_public_id,
    save_calendar_items as db_save_calendar_items,
    save_games as db_save_games,
    save_players as db_save_players,
    save_settings as db_save_settings,
    select_membership,
)

load_dotenv(Path(__file__).resolve().parent / ".env")

app = Flask(__name__)

app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-me")

def slugify(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "team"

TEAM_NAME = os.getenv("TEAM_NAME", "Embuscade")
TEAM_SLUG = os.getenv("TEAM_SLUG", slugify(TEAM_NAME))
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "valent1lefranc@gmail.com").strip().lower()

# In container we always use /app/data (mounted from host).
# In local dev, fallback to repo ./data if /app/data doesn't exist.
_env_data_dir = os.getenv("DATA_DIR")
if _env_data_dir:
    DATA_DIR = Path(_env_data_dir)
else:
    _container_dir = Path("/app/data")
    DATA_DIR = _container_dir if _container_dir.exists() else (Path(__file__).resolve().parent / "data")
DATA_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_MATRIX_STATES = {
    "GAMBLE", "UNKNOWN", "EASY", "WIN",
    "S_WIN", "S_LOOSE", "LOOSE", "HELP"
}

ALLOWED_ARCHETYPE_ROLES = {"defense", "attack", "blunt"}

FORCE_DISPOSITIONS = [
    "Priority assets",
    "Recon",
    "Take and hold",
    "Purge the foes",
    "Disruption",
]

TERRAIN_MAPS_PER_COMBINATION = 3
TERRAIN_LAYOUT_DIR = DATA_DIR / "terrain"
TERRAIN_LAYOUT_DIR.mkdir(parents=True, exist_ok=True)
TERRAIN_IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
TERRAIN_FILE_LABELS = {
    "Priority assets": "Priority-Assets",
    "Recon": "Reconnaissance",
    "Take and hold": "Take-and-Hold",
    "Purge the foes": "Purge-the-Foe",
    "Disruption": "Disruption",
}
TERRAIN_LAYOUT_LETTERS = {
    1: "A",
    2: "B",
    3: "C",
}


PAIRING_SCORE_MAP = {
    "grosse_defaite": 0.0,
    "defaite": 5.0,
    "petite_defaite": 8.0,
    "petite_victoire": 12.0,
    "victoire": 15.0,
    "grosse_victoire": 20.0,
}

STATE_TO_SCORE = {
    "HELP": PAIRING_SCORE_MAP["grosse_defaite"],
    "LOOSE": PAIRING_SCORE_MAP["defaite"],
    "S_LOOSE": PAIRING_SCORE_MAP["petite_defaite"],
    "S_WIN": PAIRING_SCORE_MAP["petite_victoire"],
    "WIN": PAIRING_SCORE_MAP["victoire"],
    "EASY": PAIRING_SCORE_MAP["grosse_victoire"],
    "UNKNOWN": 10.0,
    "GAMBLE": 10.0,
}

FIGHT_PHASE_BY_REMAINING = {
    8: {"kind": "standard", "label": "First defense", "slot_numbers": [1, 2]},
    6: {"kind": "standard", "label": "Second defense", "slot_numbers": [3, 4]},
    4: {"kind": "round3", "label": "Third defense", "slot_numbers": [5, 6, 7, 8]},
    0: {"kind": "complete", "label": "Round complete", "slot_numbers": []},
}

def default_list_text(player: dict):
    lists = player.get("lists") or []
    idx = player.get("default_index")
    if isinstance(idx, int) and 0 <= idx < len(lists):
        return lists[idx]
    return None

def normalize_force_disposition(value):
    if not isinstance(value, str):
        return ""
    raw = value.strip()
    for item in FORCE_DISPOSITIONS:
        if raw.lower() == item.lower():
            return item
    return ""


def force_disposition_slug(value):
    normalized = normalize_force_disposition(value)
    return slugify(normalized) if normalized else ""


def terrain_pair_key(our_force_disposition, opponent_force_disposition):
    our_slug = force_disposition_slug(our_force_disposition)
    opponent_slug = force_disposition_slug(opponent_force_disposition)
    if not our_slug or not opponent_slug:
        return ""
    return f"{our_slug}_vs_{opponent_slug}"


def terrain_map_id(our_force_disposition, opponent_force_disposition, index):
    key = terrain_pair_key(our_force_disposition, opponent_force_disposition)
    if not key:
        return ""
    return f"{key}_{index}"


def terrain_file_label(value):
    normalized = normalize_force_disposition(value)
    return TERRAIN_FILE_LABELS.get(normalized, "")


def terrain_image_file_for(our_force_disposition, opponent_force_disposition, index):
    our_slug = force_disposition_slug(our_force_disposition)
    opponent_slug = force_disposition_slug(opponent_force_disposition)
    our_file_label = terrain_file_label(our_force_disposition)
    opponent_file_label = terrain_file_label(opponent_force_disposition)
    layout_letter = TERRAIN_LAYOUT_LETTERS.get(index)
    if not our_slug or not opponent_slug or not our_file_label or not opponent_file_label or not layout_letter:
        return None

    ordered_stems = [
        f"{our_file_label}_vs_{opponent_file_label}_Layout-{layout_letter}",
        f"{opponent_file_label}_vs_{our_file_label}_Layout-{layout_letter}",
        f"{our_slug}_vs_{opponent_slug}_{index}",
        f"{opponent_slug}_vs_{our_slug}_{index}",
    ]
    for stem in ordered_stems:
        for ext in TERRAIN_IMAGE_EXTENSIONS:
            rel_path = Path("terrain") / f"{stem}{ext}"
            if (DATA_DIR / rel_path).exists():
                return rel_path.as_posix()
    return None


def terrain_options_for(our_force_disposition, opponent_force_disposition):
    our_force = normalize_force_disposition(our_force_disposition)
    opponent_force = normalize_force_disposition(opponent_force_disposition)
    if not our_force or not opponent_force:
        return []

    combination = f"{our_force} vs {opponent_force}"
    options = []
    for index in range(1, TERRAIN_MAPS_PER_COMBINATION + 1):
        file_path = terrain_image_file_for(our_force, opponent_force, index)
        options.append({
            "id": terrain_map_id(our_force, opponent_force, index),
            "n": index,
            "label": f"Layout {TERRAIN_LAYOUT_LETTERS[index]}",
            "combination": combination,
            "our_force_disposition": our_force,
            "opponent_force_disposition": opponent_force,
            "file": file_path,
            "placeholder": file_path is None,
        })
    return options


def all_terrain_layouts():
    combinations = {}
    for our_force in FORCE_DISPOSITIONS:
        for opponent_force in FORCE_DISPOSITIONS:
            combinations[terrain_pair_key(our_force, opponent_force)] = terrain_options_for(our_force, opponent_force)
    return combinations


def valid_terrain_map_id(value, our_force_disposition, opponent_force_disposition):
    if not isinstance(value, str) or not value.strip():
        return False
    valid_ids = {
        option["id"]
        for option in terrain_options_for(our_force_disposition, opponent_force_disposition)
    }
    return value.strip() in valid_ids

def list_name_at(player: dict, index: int):
    names = player.get("list_names") or []
    if isinstance(index, int) and 0 <= index < len(names):
        name = names[index]
        if isinstance(name, str) and name.strip():
            return name.strip()
    return f"List #{index + 1}"

def list_force_disposition_at(player: dict, index: int):
    values = player.get("list_force_dispositions") or []
    if isinstance(index, int) and 0 <= index < len(values):
        return normalize_force_disposition(values[index])
    return ""

def default_list_name(player: dict):
    lists = player.get("lists") or []
    idx = player.get("default_index")
    if isinstance(idx, int) and 0 <= idx < len(lists):
        return list_name_at(player, idx)
    if lists:
        return list_name_at(player, 0)
    return "No default list"

def default_force_disposition(player: dict):
    lists = player.get("lists") or []
    idx = player.get("default_index")
    if isinstance(idx, int) and 0 <= idx < len(lists):
        return list_force_disposition_at(player, idx)
    if lists:
        return list_force_disposition_at(player, 0)
    return ""


def is_filled_pairing_slot(pairing):
    if not isinstance(pairing, dict):
        return False
    return isinstance(pairing.get("player_id"), int) and isinstance(pairing.get("army_index"), int)


def player_brief(entry: dict):
    if not isinstance(entry, dict):
        return {"player_id": None, "name": "Unknown player", "list_name": "", "force_disposition": ""}
    return {
        "player_id": entry.get("player_id"),
        "name": entry.get("player_name") or f"Player {entry.get('player_id')}",
        "list_name": entry.get("list_name") or "No default list",
        "force_disposition": normalize_force_disposition(entry.get("list_force_disposition")),
    }


def army_brief(army: dict, army_index: int):
    army = army if isinstance(army, dict) else {}
    return {
        "army_index": army_index,
        "player_name": (army.get("player_name") or "").strip() or f"Opponent #{army_index + 1}",
        "faction": (army.get("faction") or "").strip() or f"Army #{army_index + 1}",
        "force_disposition": normalize_force_disposition(army.get("force_disposition")),
    }


def validate_fight_assistant_pairings(pairings):
    if not isinstance(pairings, list):
        raise ValueError("pairings must be a list")

    used_players = set()
    used_armies = set()
    filled_slots = []

    for pairing in pairings:
        if not isinstance(pairing, dict):
            raise ValueError("Invalid pairing entry")

        has_player = isinstance(pairing.get("player_id"), int)
        has_army = isinstance(pairing.get("army_index"), int)
        if has_player != has_army:
            raise ValueError("Finish or clear the current slot before using the pairing assistant.")
        if not has_player:
            continue

        game_no = pairing.get("game_no")
        player_id = pairing.get("player_id")
        army_index = pairing.get("army_index")

        if not isinstance(game_no, int) or not (1 <= game_no <= 8):
            raise ValueError("game_no must be between 1 and 8")
        if player_id in used_players or army_index in used_armies:
            raise ValueError("Current pairings contain duplicate players or duplicate opponent armies.")

        used_players.add(player_id)
        used_armies.add(army_index)
        filled_slots.append(game_no)

    filled_slots.sort()
    expected_prefix = list(range(1, len(filled_slots) + 1))
    if filled_slots != expected_prefix:
        raise ValueError("The pairing assistant expects previous rounds to be locked in order from Game 1.")

    if len(filled_slots) not in {0, 2, 4, 8}:
        raise ValueError("The pairing assistant can only advise at the start of a new pairing round.")

    return {
        "used_players": used_players,
        "used_armies": used_armies,
        "filled_count": len(filled_slots),
    }


def build_fight_solver_context(game, pairings):
    roster = game.get("roster") if isinstance(game.get("roster"), list) else []
    armies = game.get("armies") if isinstance(game.get("armies"), list) else []
    matrix = game.get("matrix") if isinstance(game.get("matrix"), dict) else {}

    if len(roster) != 8:
        raise ValueError(f"Need exactly 8 roster players (found {len(roster)})")
    if len(armies) != 8:
        raise ValueError(f"Need exactly 8 opponent codex (found {len(armies)})")

    pairing_state = validate_fight_assistant_pairings(pairings)
    used_players = pairing_state["used_players"]
    used_armies = pairing_state["used_armies"]

    remaining_players = [
        player for player in roster
        if isinstance(player, dict) and isinstance(player.get("player_id"), int) and player.get("player_id") not in used_players
    ]
    remaining_armies = [
        (army_index, army)
        for army_index, army in enumerate(armies)
        if army_index not in used_armies
    ]

    remaining_count = len(remaining_players)
    if remaining_count != len(remaining_armies):
        raise ValueError("Mismatch between remaining roster players and opponent armies.")
    if remaining_count not in FIGHT_PHASE_BY_REMAINING:
        raise ValueError("The pairing assistant only supports 8, 6, 4, or 0 remaining matchups.")

    player_infos = [player_brief(player) for player in remaining_players]
    army_infos = [army_brief(army, army_index) for army_index, army in remaining_armies]
    local_player_by_id = {info["player_id"]: idx for idx, info in enumerate(player_infos)}
    local_army_by_index = {info["army_index"]: idx for idx, info in enumerate(army_infos)}

    score_matrix = []
    missing_cells = []
    for player_info in player_infos:
        row = []
        for army_info in army_infos:
            key = f"{player_info['player_id']}-{army_info['army_index']}"
            state = matrix.get(key)
            score = STATE_TO_SCORE.get(state)
            if score is None:
                missing_cells.append({
                    "player_id": player_info["player_id"],
                    "army_index": army_info["army_index"],
                })
                score = -9999.0
            row.append(score)
        score_matrix.append(row)

    if missing_cells:
        raise ValueError("Matrix incomplete: some remaining cells are not filled")

    return {
        "phase": FIGHT_PHASE_BY_REMAINING[remaining_count],
        "remaining_count": remaining_count,
        "player_infos": player_infos,
        "army_infos": army_infos,
        "local_player_by_id": local_player_by_id,
        "local_army_by_index": local_army_by_index,
        "score_matrix": score_matrix,
        "missing_cells": missing_cells,
    }


def build_solver_plan_item(game_no, player_info, army_info):
    return {
        "game_no": game_no,
        "player_id": player_info["player_id"],
        "army_index": army_info["army_index"],
        "player_name": player_info["name"],
        "opponent_name": army_info["player_name"],
        "opponent_faction": army_info["faction"],
    }


def compute_selected_defender_score(ctx, solver, remaining_locals, remaining_mask, our_defender_local):
    if ctx["remaining_count"] == 4:
        return min(
            solver.solve_after_defenders_round3_value(
                remaining_mask,
                remaining_mask,
                our_defender_local,
                their_def,
            )
            for their_def in remaining_locals
        )

    return min(
        solver.solve_after_defenders_standard_value(
            remaining_mask,
            remaining_mask,
            our_defender_local,
            their_def,
        )
        for their_def in remaining_locals
    )


def solve_defender_branch(ctx, solver, remaining_locals, our_defender_local, enemy_defender_local):
    if ctx["remaining_count"] == 4:
        return solver.solve_after_defenders_round3(
            remaining_locals,
            remaining_locals,
            our_defender_local,
            enemy_defender_local,
        )

    return solver.solve_after_defenders_standard(
        remaining_locals,
        remaining_locals,
        our_defender_local,
        enemy_defender_local,
    )


def solve_defender_branch_for_state(solver, ours, theirs, our_defender_local, enemy_defender_local):
    if len(ours) == 4:
        return solver.solve_after_defenders_round3(
            ours,
            theirs,
            our_defender_local,
            enemy_defender_local,
        )

    return solver.solve_after_defenders_standard(
        ours,
        theirs,
        our_defender_local,
        enemy_defender_local,
    )


def build_plan_item_from_locals(ctx, game_no, our_local, their_local):
    return build_solver_plan_item(
        game_no,
        ctx["player_infos"][our_local],
        ctx["army_infos"][their_local],
    )


def simulate_mirror_step(ctx, solver, ours, theirs, forced_our_defs_by_remaining=None, forced_enemy_defs_by_remaining=None):
    ours = tuple(ours)
    theirs = tuple(theirs)
    forced_our_defs_by_remaining = forced_our_defs_by_remaining or {}
    forced_enemy_defs_by_remaining = forced_enemy_defs_by_remaining or {}

    if len(ours) != len(theirs):
        raise ValueError("Mirror simulation needs the same number of remaining players on both sides.")
    if len(ours) == 0:
        return {"total_score": 0.0, "steps": [], "final_plan": []}

    phase = FIGHT_PHASE_BY_REMAINING[len(ours)]
    forced_our_def = forced_our_defs_by_remaining.get(len(ours))
    if forced_our_def is not None and forced_our_def in ours:
        our_defender_local = forced_our_def
    else:
        our_defender_local = solver.recommend_defender(ours, theirs)["best_defender"]

    branch_by_enemy_def = {
        enemy_def_local: solve_defender_branch_for_state(solver, ours, theirs, our_defender_local, enemy_def_local)
        for enemy_def_local in theirs
    }
    forced_enemy_def = forced_enemy_defs_by_remaining.get(len(theirs))
    if forced_enemy_def is not None and forced_enemy_def in theirs:
        enemy_defender_local = forced_enemy_def
    else:
        enemy_defender_local = min(branch_by_enemy_def, key=lambda idx: branch_by_enemy_def[idx]["value"])

    defender_detail = branch_by_enemy_def[enemy_defender_local]
    attack_pair_local = tuple(defender_detail["best_attack_pair"])
    enemy_attack_pair_local, attack_detail = min(
        defender_detail["by_enemy_attack_pair"].items(),
        key=lambda item: item[1]["value"],
    )

    accepted_enemy_local = attack_detail["best_accept"]
    accepted_our_local = attack_detail["enemy_best_accept"]
    refused_enemy_local = other_of_pair(enemy_attack_pair_local, accepted_enemy_local)
    refused_our_local = other_of_pair(attack_pair_local, accepted_our_local)

    step = {
        "phase_kind": phase["kind"],
        "phase_label": phase["label"],
        "our_defender_local": our_defender_local,
        "our_defender_label": format_report_player(ctx["player_infos"][our_defender_local]),
        "enemy_defender_local": enemy_defender_local,
        "enemy_defender_label": format_report_army(ctx["army_infos"][enemy_defender_local]),
        "our_attackers_label": " + ".join(format_report_player(ctx["player_infos"][idx]) for idx in attack_pair_local),
        "enemy_attackers_label": " + ".join(format_report_army(ctx["army_infos"][idx]) for idx in enemy_attack_pair_local),
        "accepted_enemy_label": format_report_army(ctx["army_infos"][accepted_enemy_local]),
        "accepted_our_label": format_report_player(ctx["player_infos"][accepted_our_local]),
        "refused_label": (
            f"{format_report_player(ctx['player_infos'][refused_our_local])} "
            f"vs {format_report_army(ctx['army_infos'][refused_enemy_local])}"
        ),
        "leftovers_label": None,
        "locked_plan": [],
        "remaining_tables": 0,
        "remaining_total": 0.0,
        "next_our_defender_label": None,
        "projected_total": 0.0,
    }

    if len(ours) == 4:
        our_leftover_local = attack_detail["our_forgotten"]
        their_leftover_local = attack_detail["their_forgotten"]
        final_plan = [
            build_plan_item_from_locals(ctx, phase["slot_numbers"][0], our_defender_local, accepted_enemy_local),
            build_plan_item_from_locals(ctx, phase["slot_numbers"][1], accepted_our_local, enemy_defender_local),
            build_plan_item_from_locals(ctx, phase["slot_numbers"][2], refused_our_local, refused_enemy_local),
            build_plan_item_from_locals(ctx, phase["slot_numbers"][3], our_leftover_local, their_leftover_local),
        ]
        total_score = round(
            solver.matchup_score(our_defender_local, accepted_enemy_local)
            + solver.matchup_score(accepted_our_local, enemy_defender_local)
            + solver.matchup_score(refused_our_local, refused_enemy_local)
            + solver.matchup_score(our_leftover_local, their_leftover_local),
            1,
        )
        step["leftovers_label"] = (
            f"{format_report_player(ctx['player_infos'][our_leftover_local])} "
            f"vs {format_report_army(ctx['army_infos'][their_leftover_local])}"
        )
        step["locked_plan"] = list(final_plan)
        return {
            "step": step,
            "phase": phase,
            "enemy_defender_local": enemy_defender_local,
            "enemy_defender_label": format_report_army(ctx["army_infos"][enemy_defender_local]),
            "immediate_score": total_score,
            "next_ours": tuple(),
            "next_theirs": tuple(),
            "final_plan": final_plan,
            "is_terminal": True,
        }

    current_plan = [
        build_plan_item_from_locals(ctx, phase["slot_numbers"][0], our_defender_local, accepted_enemy_local),
        build_plan_item_from_locals(ctx, phase["slot_numbers"][1], accepted_our_local, enemy_defender_local),
    ]
    next_ours = tuple(sorted(
        idx for idx in ours
        if idx not in {our_defender_local, accepted_our_local}
    ))
    next_theirs = tuple(sorted(
        idx for idx in theirs
        if idx not in {enemy_defender_local, accepted_enemy_local}
    ))
    immediate_score = round(
        solver.matchup_score(our_defender_local, accepted_enemy_local)
        + solver.matchup_score(accepted_our_local, enemy_defender_local)
        ,
        1,
    )

    step["locked_plan"] = current_plan
    return {
        "step": step,
        "phase": phase,
        "enemy_defender_local": enemy_defender_local,
        "enemy_defender_label": format_report_army(ctx["army_infos"][enemy_defender_local]),
        "immediate_score": immediate_score,
        "next_ours": next_ours,
        "next_theirs": next_theirs,
        "final_plan": current_plan,
        "is_terminal": False,
    }


def simulate_mirror_line(ctx, solver, ours, theirs, forced_our_defs_by_remaining=None, forced_enemy_defs_by_remaining=None):
    step_data = simulate_mirror_step(
        ctx,
        solver,
        ours,
        theirs,
        forced_our_defs_by_remaining=forced_our_defs_by_remaining,
        forced_enemy_defs_by_remaining=forced_enemy_defs_by_remaining,
    )

    step = dict(step_data["step"])
    if step_data["is_terminal"]:
        total_score = round(step_data["immediate_score"], 1)
        step["projected_total"] = total_score
        return {
            "total_score": total_score,
            "steps": [step],
            "final_plan": list(step_data["final_plan"]),
        }

    next_line = simulate_mirror_line(
        ctx,
        solver,
        step_data["next_ours"],
        step_data["next_theirs"],
        forced_our_defs_by_remaining=forced_our_defs_by_remaining,
        forced_enemy_defs_by_remaining=forced_enemy_defs_by_remaining,
    )
    total_score = round(step_data["immediate_score"] + next_line["total_score"], 1)
    step["remaining_tables"] = len(step_data["next_ours"])
    step["remaining_total"] = round(next_line["total_score"], 1)
    if next_line["steps"]:
        step["next_our_defender_label"] = next_line["steps"][0]["our_defender_label"]
    step["projected_total"] = total_score

    return {
        "total_score": total_score,
        "steps": [step] + next_line["steps"],
        "final_plan": list(step_data["final_plan"]) + next_line["final_plan"],
    }


def build_mirror_scenarios(ctx, solver, ours, theirs, forced_our_defs_by_remaining=None, forced_enemy_defs_by_remaining=None):
    ours = tuple(ours)
    theirs = tuple(theirs)
    forced_our_defs_by_remaining = forced_our_defs_by_remaining or {}
    forced_enemy_defs_by_remaining = forced_enemy_defs_by_remaining or {}

    if len(ours) == 0:
        return []

    phase = FIGHT_PHASE_BY_REMAINING[len(ours)]
    forced_enemy_def = forced_enemy_defs_by_remaining.get(len(theirs))
    if forced_enemy_def is None:
        scenarios = []
        for enemy_defender_local in theirs:
            scenario_enemy_defs_by_remaining = dict(forced_enemy_defs_by_remaining)
            scenario_enemy_defs_by_remaining[len(theirs)] = enemy_defender_local
            full_line = simulate_mirror_line(
                ctx,
                solver,
                ours,
                theirs,
                forced_our_defs_by_remaining=forced_our_defs_by_remaining,
                forced_enemy_defs_by_remaining=scenario_enemy_defs_by_remaining,
            )
            scenarios.append({
                "branch_phase_label": phase["label"],
                "enemy_defender": ctx["army_infos"][enemy_defender_local],
                "enemy_defender_label": format_report_army(ctx["army_infos"][enemy_defender_local]),
                "score": round(full_line["total_score"], 1),
                "steps": full_line["steps"],
                "final_plan": full_line["final_plan"],
            })
        return scenarios

    step_data = simulate_mirror_step(
        ctx,
        solver,
        ours,
        theirs,
        forced_our_defs_by_remaining=forced_our_defs_by_remaining,
        forced_enemy_defs_by_remaining=forced_enemy_defs_by_remaining,
    )

    if step_data["is_terminal"]:
        step = dict(step_data["step"])
        total_score = round(step_data["immediate_score"], 1)
        step["projected_total"] = total_score
        return [{
            "branch_phase_label": phase["label"],
            "enemy_defender": ctx["army_infos"][step_data["enemy_defender_local"]],
            "enemy_defender_label": step_data["enemy_defender_label"],
            "score": total_score,
            "steps": [step],
            "final_plan": list(step_data["final_plan"]),
        }]

    child_scenarios = build_mirror_scenarios(
        ctx,
        solver,
        step_data["next_ours"],
        step_data["next_theirs"],
        forced_our_defs_by_remaining=forced_our_defs_by_remaining,
        forced_enemy_defs_by_remaining=forced_enemy_defs_by_remaining,
    )

    scenarios = []
    for child in child_scenarios:
        step = dict(step_data["step"])
        total_score = round(step_data["immediate_score"] + child["score"], 1)
        step["remaining_tables"] = len(step_data["next_ours"])
        step["remaining_total"] = round(child["score"], 1)
        if child["steps"]:
            step["next_our_defender_label"] = child["steps"][0]["our_defender_label"]
        step["projected_total"] = total_score
        scenarios.append({
            "branch_phase_label": child["branch_phase_label"],
            "enemy_defender": child["enemy_defender"],
            "enemy_defender_label": child["enemy_defender_label"],
            "score": total_score,
            "steps": [step] + child["steps"],
            "final_plan": list(step_data["final_plan"]) + child["final_plan"],
        })

    return scenarios


def format_report_player(player_info):
    force_disposition = player_info.get("force_disposition")
    return f"{player_info['name']} [{force_disposition}]" if force_disposition else player_info["name"]


def format_report_army(army_info):
    detail = army_info["faction"]
    if army_info.get("force_disposition"):
        detail = f"{detail} · {army_info['force_disposition']}"
    return f"{army_info['player_name']} ({detail})"


def scenario_band(score, baseline_score):
    delta = score - baseline_score
    if delta <= 1.0:
        return "hard pressure"
    if delta <= 3.0:
        return "solid mirror line"
    if delta <= 6.0:
        return "playable branch"
    return "loose mirror line"


MIRROR_REPORT_SCENARIO_LIMIT = 5


def build_mirror_report_text(
    ctx,
    summary,
    selected_our_defender,
    selected_score,
    scenarios,
    forced_report_defenders=None,
):
    forced_report_defenders = forced_report_defenders or {}
    if not scenarios:
        return (
            "Mirror Pairing Monitor\n"
            "No meaningful opponent defender branches remain in this round."
        )

    detailed_scenarios = scenarios[:min(len(scenarios), MIRROR_REPORT_SCENARIO_LIMIT)]
    displayed_count = len(detailed_scenarios)
    lines = [
        "Mirror Pairing Monitor",
        "Autogenerated from the current round state.",
        "Assumption: the opponent reads the grid symmetrically and chooses the line that minimizes our expected team score.",
        "",
    ]

    recommended_text = (
        f"{format_report_player(summary['recommended_our_defender'])} "
        f"({summary['guaranteed_score']:.1f} team pts guaranteed)"
    )
    selected_text = (
        f"{format_report_player(selected_our_defender)} "
        f"({selected_score:.1f} team pts guaranteed)"
    )
    lines.append(f"Round analyzed: {ctx['phase']['label']}.")
    lines.append(f"Solver recommendation: {recommended_text}.")
    if selected_our_defender["player_id"] == summary["recommended_our_defender"]["player_id"]:
        lines.append(f"Analyzed defender: {selected_text}.")
    else:
        lines.append(f"Analyzed defender override: {selected_text}.")
    if forced_report_defenders.get("first_label"):
        lines.append(f"Forced first defense in report: {forced_report_defenders['first_label']}.")
    if forced_report_defenders.get("second_label"):
        lines.append(
            f"Forced second defense in report: {forced_report_defenders['second_label']} "
            "when that player is still available; otherwise the solver falls back automatically."
        )
    if forced_report_defenders.get("enemy_first_label"):
        lines.append(f"Forced opponent first defense in report: {forced_report_defenders['enemy_first_label']}.")
    if forced_report_defenders.get("enemy_second_label"):
        lines.append(
            f"Forced opponent second defense in report: {forced_report_defenders['enemy_second_label']} "
            "when that codex is still available; otherwise the mirror fallback stays active."
        )
    lines.append(f"Scenario branches checked: {len(scenarios)}.")
    if displayed_count == len(scenarios):
        lines.append(f"Detailed scenarios shown: all {displayed_count} legal branches.")
    else:
        lines.append(
            f"Detailed scenarios shown: {displayed_count} hardest branches "
            f"(lowest projected team totals)."
        )
    lines.append(
        "Important: every value below is a team total from that state. "
        "For example, 50.0 pts after the first defense means 50 team points still guaranteed across the remaining games, not 50 on one player."
    )

    for idx, scenario in enumerate(detailed_scenarios, start=1):
        lines.extend([
            "",
            (
                f"Scenario {idx}: they open with {scenario['enemy_defender_label']} "
                f"({scenario['band']}). Final projected team total: {scenario['score']:.1f} team pts."
                if scenario.get("branch_phase_label") == ctx["phase"]["label"]
                else (
                    f"Scenario {idx}: branch point at {scenario['branch_phase_label']}, "
                    f"they defend with {scenario['enemy_defender_label']} "
                    f"({scenario['band']}). Final projected team total: {scenario['score']:.1f} team pts."
                )
            ),
        ])

        for step in scenario["steps"]:
            lines.extend([
                f"{step['phase_label']}:",
                f"- We defend with: {step['our_defender_label']}.",
                f"- They defend with: {step['enemy_defender_label']}.",
                f"- Our attack pair: {step['our_attackers_label']}.",
                f"- Their attack pair: {step['enemy_attackers_label']}.",
                f"- We accept on our defense: {step['accepted_enemy_label']}.",
                f"- They accept on theirs: {step['accepted_our_label']}.",
            ])

            if step["phase_kind"] == "round3":
                lines.extend([
                    f"- Refused attackers: {step['refused_label']}.",
                    f"- Leftovers: {step['leftovers_label']}.",
                    f"- This closes the round at {step['projected_total']:.1f} team pts.",
                ])
            else:
                locked_text = " / ".join(
                    f"G{item['game_no']} {item['player_name']} vs {item['opponent_name']} ({item['opponent_faction']})"
                    for item in step["locked_plan"]
                )
                lines.extend([
                    f"- Games locked now: {locked_text}.",
                    f"- From the remaining {step['remaining_tables']} games, the solver still guarantees {step['remaining_total']:.1f} team pts.",
                    f"- If this branch happens, the next suggested defender is: {step['next_our_defender_label']}.",
                ])

        final_pairs = " / ".join(
            f"G{item['game_no']} {item['player_name']} vs {item['opponent_name']} ({item['opponent_faction']})"
            for item in scenario["final_plan"]
        )
        lines.append(f"Final projected pairings: {final_pairs}.")

    lines.extend([
        "",
        "This monitor refreshes automatically when the round state or our defender changes.",
    ])
    return "\n".join(lines)


@lru_cache(maxsize=64)
def get_cached_fight_solver(score_matrix_key, our_names, their_names):
    matrix = [list(row) for row in score_matrix_key]
    return TeamPairingSolver(matrix, list(our_names), list(their_names))

CAPTAIN_ONLY_ENDPOINTS = {
    "api_delete_player",
}


def _empty_auth_context():
    return {
        "authenticated": False,
        "ready": False,
        "is_admin": False,
        "auth_user_id": None,
        "profile_id": None,
        "email": None,
        "display_name": None,
        "membership_id": None,
        "team_id": None,
        "team_name": None,
        "team_slug": None,
        "role": None,
        "player_id": None,
        "player_name": None,
        "memberships": [],
    }


def current_auth():
    return getattr(g, "auth_context", _empty_auth_context())


def current_team_id():
    return current_auth().get("team_id")


def is_site_admin(context: dict | None = None):
    context = context or current_auth()
    email = (context.get("email") or "").strip().lower()
    return bool(email and email == ADMIN_EMAIL)


def auth_error_response(message: str, status_code: int):
    if request.path.startswith("/api/"):
        return jsonify({"error": message}), status_code
    if status_code == 403 and current_auth().get("authenticated"):
        if not current_auth().get("ready"):
            return redirect(url_for("team_access_page"))
        return message, status_code
    return redirect(url_for("index"))


@app.before_request
def hydrate_auth_context():
    auth_user_id = session.get("auth_user_id")
    membership_id = session.get("membership_id")
    try:
        context = get_auth_context(auth_user_id, membership_id)
    except Exception as exc:
        app.logger.warning("Failed to hydrate auth context: %s", exc)
        context = _empty_auth_context()

    context["is_admin"] = is_site_admin(context)
    g.auth_context = context

    if context.get("authenticated"):
        session["auth_user_id"] = context["auth_user_id"]
        if context.get("membership_id"):
            session["membership_id"] = context["membership_id"]
        else:
            session.pop("membership_id", None)
    else:
        session.pop("auth_user_id", None)
        session.pop("membership_id", None)

    if request.endpoint in CAPTAIN_ONLY_ENDPOINTS:
        if not context.get("authenticated"):
            return auth_error_response("Authentication required.", 401)
        if not context.get("ready"):
            return auth_error_response("Choose or join a team first.", 403)
        if context.get("role") != "captain":
            return auth_error_response("Captain access required to delete players.", 403)


@app.context_processor
def inject_auth_context():
    return {"auth_context": current_auth()}


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not current_auth().get("authenticated"):
            return auth_error_response("Authentication required.", 401)
        if not current_auth().get("ready"):
            return auth_error_response("Choose or join a team first.", 403)
        return view(*args, **kwargs)
    return wrapped


def authenticated_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not current_auth().get("authenticated"):
            return auth_error_response("Authentication required.", 401)
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not current_auth().get("authenticated"):
            return auth_error_response("Authentication required.", 401)
        if not current_auth().get("is_admin"):
            return auth_error_response("Site admin access required.", 403)
        return view(*args, **kwargs)
    return wrapped

def load_games():
    return db_load_games(current_team_id())

def load_game(game_id):
    return db_load_game(current_team_id(), game_id)

def save_games(games):
    db_save_games(current_team_id(), games)

def next_game_id(games):
    return next_public_id("games")

def load_players():
    return normalize_players(db_load_players(current_team_id()))

def normalize_players(players):
    for p in players:
        if not isinstance(p, dict):
            continue
        if "archetypes" not in p or not isinstance(p.get("archetypes"), list):
            p["archetypes"] = []
        for archetype in p["archetypes"]:
            if isinstance(archetype, dict):
                archetype["force_disposition"] = normalize_force_disposition(
                    archetype.get("force_disposition")
                )
        if "lists" not in p or not isinstance(p.get("lists"), list):
            p["lists"] = []
        names = p.get("list_names")
        if not isinstance(names, list):
            names = []
        normalized_names = []
        for i, _ in enumerate(p["lists"]):
            raw = names[i] if i < len(names) else ""
            normalized_names.append(raw.strip() if isinstance(raw, str) and raw.strip() else f"List #{i + 1}")
        p["list_names"] = normalized_names
        force_values = p.get("list_force_dispositions")
        if not isinstance(force_values, list):
            force_values = []
        normalized_force_values = []
        for i, _ in enumerate(p["lists"]):
            raw = force_values[i] if i < len(force_values) else ""
            normalized_force_values.append(normalize_force_disposition(raw))
        p["list_force_dispositions"] = normalized_force_values
        if "default_index" not in p:
            p["default_index"] = None
        if "match_history" not in p or not isinstance(p.get("match_history"), list):
            p["match_history"] = []
    return players

def save_players(players):
    db_save_players(current_team_id(), players)

def load_settings():
    return db_load_settings(current_team_id())

def save_settings(settings):
    db_save_settings(current_team_id(), settings)

def load_calendar_items():
    return db_load_calendar_items(current_team_id())

def save_calendar_items(items):
    db_save_calendar_items(current_team_id(), items)

def next_calendar_id(items):
    return next_public_id("calendar_items")

def send_discord_message(content: str):
    settings = load_settings()
    webhook = (settings.get("discord_webhook") or "").strip()
    if not webhook or not content:
        app.logger.info("Discord webhook not configured or empty message. Skipping.")
        return False
    masked = f"{webhook[:6]}...{webhook[-4:]}" if len(webhook) >= 12 else "<short>"
    app.logger.info("Discord webhook target: %s", masked)
    payload = json.dumps({"content": content}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "pairingapp-webhook/1.0"
    }
    req = Request(webhook, data=payload, headers=headers)
    try:
        with urlopen(req, timeout=3) as resp:
            code = resp.getcode()
        app.logger.info("Discord webhook sent (%s).", code)
        return True
    except (HTTPError, URLError, ValueError) as exc:
        if isinstance(exc, HTTPError):
            try:
                body = exc.read().decode("utf-8", errors="ignore")
            except Exception:
                body = ""
            app.logger.warning(
                "Discord webhook failed: HTTP %s. Body: %s",
                exc.code,
                body or "<empty>"
            )
        else:
            app.logger.warning("Discord webhook failed: %s", exc)
        return False

def next_player_id(players):
    return next_public_id("players")


def normalize_player_name(name) -> str:
    if not isinstance(name, str):
        return ""
    return re.sub(r"\s+", " ", name).strip()


def requested_player_names(payload: dict) -> list[str]:
    names = []

    single_name = normalize_player_name(payload.get("name"))
    if single_name:
        names.append(single_name)

    raw_names = payload.get("names")
    if isinstance(raw_names, list):
        for raw_name in raw_names:
            name = normalize_player_name(raw_name)
            if name:
                names.append(name)

    return names


def apply_session_context(context: dict):
    session["auth_user_id"] = context.get("auth_user_id")
    if context.get("membership_id"):
        session["membership_id"] = context.get("membership_id")
    else:
        session.pop("membership_id", None)


def auth_payload(context: dict | None = None):
    context = context or current_auth()
    return {
        "authenticated": bool(context.get("authenticated")),
        "ready": bool(context.get("ready")),
        "is_admin": is_site_admin(context),
        "email": context.get("email"),
        "display_name": context.get("display_name"),
        "membership_id": context.get("membership_id"),
        "team_id": context.get("team_id"),
        "team_name": context.get("team_name"),
        "team_slug": context.get("team_slug"),
        "role": context.get("role"),
        "player_id": context.get("player_id"),
        "player_name": context.get("player_name"),
        "memberships": context.get("memberships") or [],
    }


def require_authenticated_user():
    if not current_auth().get("authenticated"):
        return jsonify({"error": "Authentication required."}), 401
    return None


def ensure_can_manage_player(player_id: int):
    return None


def matrix_key_belongs_to_player(key, player_id: int):
    if not isinstance(key, str):
        return False
    raw_player_id = key.split("-", 1)[0]
    try:
        return int(raw_player_id) == player_id
    except (TypeError, ValueError):
        return False


def clear_deleted_player_pairing_slot(pairing: dict, player_id: int):
    if not isinstance(pairing, dict) or pairing.get("player_id") != player_id:
        return pairing, False

    cleared = dict(pairing)
    cleared["player_id"] = None
    cleared["army_index"] = None
    cleared["layout_n"] = None
    cleared["terrain_map_id"] = None
    cleared.pop("real_score", None)
    return cleared, True


def cleanup_player_references(player_id: int):
    summary = {
        "games_touched": 0,
        "roster_entries_removed": 0,
        "matrix_entries_removed": 0,
        "pairing_slots_cleared": 0,
        "calendar_items_removed": 0,
        "calendar_items_unassigned": 0,
    }

    games = load_games()
    games_changed = False
    for game in games:
        game_changed = False

        roster = game.get("roster")
        if isinstance(roster, list):
            new_roster = [
                entry for entry in roster
                if not (isinstance(entry, dict) and entry.get("player_id") == player_id)
            ]
            removed = len(roster) - len(new_roster)
            if removed:
                game["roster"] = new_roster
                summary["roster_entries_removed"] += removed
                game_changed = True

        player_ids = game.get("player_ids")
        if isinstance(player_ids, list) and player_id in player_ids:
            game["player_ids"] = [pid for pid in player_ids if pid != player_id]
            game_changed = True

        matrix = game.get("matrix")
        if isinstance(matrix, dict):
            new_matrix = {
                key: value
                for key, value in matrix.items()
                if not matrix_key_belongs_to_player(key, player_id)
            }
            removed = len(matrix) - len(new_matrix)
            if removed:
                game["matrix"] = new_matrix
                summary["matrix_entries_removed"] += removed
                game_changed = True

        pairings = game.get("pairings")
        if isinstance(pairings, list):
            new_pairings = []
            cleared_count = 0
            for pairing in pairings:
                new_pairing, cleared = clear_deleted_player_pairing_slot(pairing, player_id)
                new_pairings.append(new_pairing)
                if cleared:
                    cleared_count += 1
            if cleared_count:
                game["pairings"] = new_pairings
                summary["pairing_slots_cleared"] += cleared_count
                game_changed = True

        if game_changed:
            summary["games_touched"] += 1
            games_changed = True

    if games_changed:
        save_games(games)

    calendar_items = load_calendar_items()
    new_calendar_items = []
    calendar_changed = False
    for item in calendar_items:
        if item.get("player_id") != player_id:
            new_calendar_items.append(item)
            continue

        calendar_changed = True
        if item.get("type") == "availability":
            summary["calendar_items_removed"] += 1
            continue

        updated_item = dict(item)
        updated_item["player_id"] = None
        new_calendar_items.append(updated_item)
        summary["calendar_items_unassigned"] += 1

    if calendar_changed:
        save_calendar_items(new_calendar_items)

    return summary


@app.route("/api/session", methods=["GET"])
def api_session():
    return jsonify(auth_payload())

@app.route("/api/login", methods=["POST"])
def api_login():
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""

    if not email or not password:
        return jsonify({"error": "Email and password are required."}), 400

    try:
        response = get_supabase_client().auth.sign_in_with_password(
            {"email": email, "password": password}
        )
        user = getattr(response, "user", None)
        auth_session = getattr(response, "session", None)
        if not user or not auth_session:
            return jsonify({"error": "Login failed."}), 401

        display_name = (getattr(user, "user_metadata", None) or {}).get("display_name")
        ensure_profile(user.id, user.email or email, display_name)
        context = get_auth_context(user.id, session.get("membership_id"))
        apply_session_context(context)
        return jsonify({"status": "ok", "session": auth_payload(context)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 401


@app.route("/api/signup", methods=["POST"])
def api_signup():
    payload = request.get_json(silent=True) or {}
    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""
    display_name = (payload.get("display_name") or "").strip()

    if not email or not password:
        return jsonify({"error": "Email and password are required."}), 400
    if not display_name:
        return jsonify({"error": "Display name is required."}), 400

    try:
        response = get_supabase_client().auth.sign_up(
            {
                "email": email,
                "password": password,
                "options": {"data": {"display_name": display_name}},
            }
        )
        user = getattr(response, "user", None)
        auth_session = getattr(response, "session", None)
        if not user:
            return jsonify({"error": "Could not create account."}), 400

        ensure_profile(user.id, user.email or email, display_name)

        if not auth_session:
            return jsonify(
                {
                    "status": "pending_confirmation",
                    "message": "Account created. Confirm the email in Supabase before signing in.",
                }
            ), 202

        context = get_auth_context(user.id, session.get("membership_id"))
        apply_session_context(context)
        return jsonify({"status": "ok", "session": auth_payload(context)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/teams/discover", methods=["GET"])
def api_discover_teams():
    try:
        return jsonify(list_public_teams())
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/teams/select", methods=["POST"])
def api_select_team():
    auth_failure = require_authenticated_user()
    if auth_failure:
        return auth_failure

    payload = request.get_json(silent=True) or {}
    membership_id = payload.get("membership_id")
    if not isinstance(membership_id, int):
        return jsonify({"error": "membership_id must be an integer."}), 400

    try:
        context = select_membership(current_auth()["auth_user_id"], membership_id)
        apply_session_context(context)
        return jsonify({"status": "ok", "session": auth_payload(context)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/teams/create", methods=["POST"])
def api_create_team():
    auth_failure = require_authenticated_user()
    if auth_failure:
        return auth_failure

    payload = request.get_json(silent=True) or {}
    team_name = (payload.get("team_name") or "").strip()
    team_password = payload.get("team_password") or ""
    role = (payload.get("role") or "").strip().lower()

    if role != "captain":
        return jsonify({"error": "A new team must be created by a captain."}), 400

    try:
        team = create_team(current_auth()["profile_id"], team_name, team_password)
        membership = join_team(
            current_auth()["profile_id"],
            int(team["id"]),
            team_password,
            "captain",
        )
        context = get_auth_context(current_auth()["auth_user_id"], int(membership["id"]))
        apply_session_context(context)
        return jsonify({"status": "ok", "team": team, "session": auth_payload(context)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/teams/join", methods=["POST"])
def api_join_team():
    auth_failure = require_authenticated_user()
    if auth_failure:
        return auth_failure

    payload = request.get_json(silent=True) or {}
    team_id = payload.get("team_id")
    team_password = payload.get("team_password") or ""
    role = (payload.get("role") or "").strip().lower()

    if not isinstance(team_id, int):
        return jsonify({"error": "team_id must be an integer."}), 400

    try:
        membership = join_team(
            current_auth()["profile_id"],
            team_id,
            team_password,
            role,
        )
        context = get_auth_context(current_auth()["auth_user_id"], int(membership["id"]))
        apply_session_context(context)
        return jsonify({"status": "ok", "session": auth_payload(context)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/admin")
@admin_required
def admin_page():
    return render_template("admin.html", admin_email=ADMIN_EMAIL)


@app.route("/api/admin/overview", methods=["GET"])
@admin_required
def api_admin_overview():
    try:
        return jsonify(admin_overview())
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/admin/teams/<int:team_id>", methods=["PATCH"])
@admin_required
def api_admin_rename_team(team_id):
    payload = request.get_json(silent=True) or {}
    team_name = (payload.get("name") or "").strip()
    try:
        team = admin_rename_team(team_id, team_name)
        return jsonify({"status": "ok", "team": team})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/admin/teams/<int:team_id>", methods=["DELETE"])
@admin_required
def api_admin_delete_team(team_id):
    try:
        team = admin_delete_team(team_id)
        if current_auth().get("team_id") == team_id:
            session.pop("membership_id", None)
        return jsonify({"status": "ok", "team": team})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/admin/profiles/<int:profile_id>", methods=["PATCH"])
@admin_required
def api_admin_rename_profile(profile_id):
    payload = request.get_json(silent=True) or {}
    display_name = (payload.get("display_name") or "").strip()
    try:
        profile = admin_rename_profile(profile_id, display_name)
        return jsonify({"status": "ok", "profile": profile})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/admin/profiles/<int:profile_id>", methods=["DELETE"])
@admin_required
def api_admin_delete_profile(profile_id):
    if current_auth().get("profile_id") == profile_id:
        return jsonify({"error": "You cannot delete the active admin profile."}), 400
    try:
        profile = admin_delete_profile(profile_id)
        return jsonify({"status": "ok", "profile": profile})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/admin/memberships/<int:membership_id>", methods=["DELETE"])
@admin_required
def api_admin_delete_membership(membership_id):
    was_current_membership = current_auth().get("membership_id") == membership_id
    try:
        membership = admin_delete_membership(membership_id)
        if was_current_membership:
            session.pop("membership_id", None)
        return jsonify({"status": "ok", "membership": membership})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"status": "ok"})


@app.route("/")
def index():
    auth = current_auth()
    team_name = auth.get("team_name") or TEAM_NAME
    return render_template("index.html",
        team_name=team_name,
        logged_in=bool(auth.get("ready")),
        authenticated=bool(auth.get("authenticated"))
    )


@app.route("/how-to-use")
def how_to_use_page():
    auth = current_auth()
    return render_template(
        "how_to_use.html",
        team_name=auth.get("team_name") or TEAM_NAME,
        logged_in=bool(auth.get("ready")),
        authenticated=bool(auth.get("authenticated")),
    )


@app.route("/teams/access")
@authenticated_required
def team_access_page():
    return render_template("team_access.html")


@app.route("/players")
@login_required
def players_page():
    # Page with UI to manage players
    return render_template("players.html")

@app.route("/roster")
@login_required
def roster_page():
    return render_template("roster_roles.html")

@app.route("/team")
@login_required
def team_management_page():
    settings = load_settings()
    return render_template("team_management.html",
        team_name=current_auth().get("team_name") or TEAM_NAME,
        webhook_url=settings.get("discord_webhook", "")
    )

@app.route("/calendar")
@login_required
def calendar_page():
    return render_template("calendar.html", team_name=current_auth().get("team_name") or TEAM_NAME)

@app.route("/api/settings", methods=["GET"])
@login_required
def api_get_settings():
    settings = load_settings()
    return jsonify({
        "discord_webhook": settings.get("discord_webhook", "")
    })

@app.route("/api/settings", methods=["POST"])
@login_required
def api_save_settings():
    payload = request.get_json(silent=True) or {}
    webhook = payload.get("discord_webhook", "")
    if webhook is None:
        webhook = ""
    if not isinstance(webhook, str):
        return jsonify({"error": "discord_webhook must be a string"}), 400

    settings = load_settings()
    settings["discord_webhook"] = webhook.strip()
    save_settings(settings)
    return jsonify({"status": "ok", "discord_webhook": settings["discord_webhook"]})

@app.route("/api/settings/test_webhook", methods=["POST"])
@login_required
def api_test_webhook():
    settings = load_settings()
    webhook = (settings.get("discord_webhook") or "").strip()
    if not webhook:
        return jsonify({"error": "No webhook configured"}), 400
    ok = send_discord_message("Test transmission: the vox relays are operational. 📡")
    if not ok:
        return jsonify({"error": "Webhook request failed. Check server logs."}), 502
    return jsonify({"status": "ok"})

@app.route("/api/settings/send_message", methods=["POST"])
@login_required
def api_send_custom_message():
    payload = request.get_json(silent=True) or {}
    content = (payload.get("content") or "").strip()
    if not content:
        return jsonify({"error": "Message content is required"}), 400
    ok = send_discord_message(content)
    if not ok:
        return jsonify({"error": "Webhook request failed. Check server logs."}), 502
    return jsonify({"status": "ok"})


# ---------- API: Calendar ----------

@app.route("/api/calendar", methods=["GET"])
@login_required
def api_get_calendar():
    items = load_calendar_items()
    # Sort by start time ascending
    items_sorted = sorted(items, key=lambda i: i.get("start", ""))
    return jsonify(items_sorted)

@app.route("/api/calendar", methods=["POST"])
@login_required
def api_create_calendar_item():
    payload = request.get_json(silent=True) or {}
    item_type = (payload.get("type") or "").strip()
    title = (payload.get("title") or "").strip()
    notes = (payload.get("notes") or "").strip()
    start_raw = (payload.get("start") or "").strip()
    end_raw = (payload.get("end") or "").strip()
    player_id = payload.get("player_id")
    game_id = payload.get("game_id")

    if item_type not in {"availability", "pairing", "game"}:
        return jsonify({"error": "type must be availability, pairing, or game"}), 400
    if not start_raw or not end_raw:
        return jsonify({"error": "start and end are required"}), 400

    try:
        start_dt = datetime.fromisoformat(start_raw)
        end_dt = datetime.fromisoformat(end_raw)
    except ValueError:
        return jsonify({"error": "start/end must be ISO-8601 datetime strings"}), 400

    if end_dt <= start_dt:
        return jsonify({"error": "end must be after start"}), 400
    if start_dt.date() != end_dt.date():
        return jsonify({"error": "start/end must be on the same day"}), 400

    if player_id is not None and not isinstance(player_id, int):
        return jsonify({"error": "player_id must be an integer"}), 400
    if game_id is not None and not isinstance(game_id, int):
        return jsonify({"error": "game_id must be an integer"}), 400

    if not title:
        if item_type == "availability":
            title = "Availability"
        elif item_type == "pairing":
            title = "Pairing Session"
        else:
            title = "Game Slot"

    items = load_calendar_items()
    new_item = {
        "id": next_calendar_id(items),
        "type": item_type,
        "title": title,
        "notes": notes,
        "start": start_dt.isoformat(timespec="minutes"),
        "end": end_dt.isoformat(timespec="minutes"),
        "player_id": player_id,
        "game_id": game_id,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    items.append(new_item)
    save_calendar_items(items)
    return jsonify(new_item), 201

@app.route("/api/calendar/<int:item_id>", methods=["DELETE"])
@login_required
def api_delete_calendar_item(item_id):
    items = load_calendar_items()
    new_items = [i for i in items if i.get("id") != item_id]
    if len(new_items) == len(items):
        return jsonify({"error": "Calendar item not found"}), 404
    save_calendar_items(new_items)
    return jsonify({"status": "ok"})


# ---------- API: Players CRUD ----------

@app.route("/api/players", methods=["GET"])
@login_required
def api_get_players():
    players = load_players()
    return jsonify(players)


@app.route("/api/players", methods=["POST"])
@login_required
def api_add_player():
    payload = request.get_json(silent=True) or {}
    names = requested_player_names(payload)
    if not names:
        return jsonify({"error": "Provide at least one player name."}), 400

    players = load_players()
    existing_name_keys = {
        normalize_player_name(player.get("name")).lower()
        for player in players
        if normalize_player_name(player.get("name"))
    }

    created = []
    skipped = []
    seen_request_keys = set()
    next_id = next_player_id(players)

    for name in names:
        key = name.lower()
        if key in seen_request_keys:
            skipped.append({"name": name, "reason": "duplicate_in_request"})
            continue
        seen_request_keys.add(key)

        if key in existing_name_keys:
            skipped.append({"name": name, "reason": "already_exists"})
            continue

        player = {
            "id": next_id,
            "name": name,
            "lists": [],
            "list_names": [],
            "list_force_dispositions": [],
            "default_index": None,
            "archetypes": [],
        }
        next_id += 1
        players.append(player)
        created.append(player)
        existing_name_keys.add(key)

    if not created:
        return jsonify({
            "error": "All provided player names already exist or were duplicates.",
            "created": [],
            "skipped": skipped,
        }), 400

    save_players(players)
    return jsonify({"created": created, "skipped": skipped}), 201


@app.route("/api/players/<int:player_id>", methods=["DELETE"])
@login_required
def api_delete_player(player_id):
    players = load_players()
    player = next((p for p in players if p.get("id") == player_id), None)
    if not player:
        return jsonify({"error": "Player not found"}), 404

    cleanup_summary = cleanup_player_references(player_id)
    remaining_players = [p for p in players if p.get("id") != player_id]
    save_players(remaining_players)

    return jsonify({
        "status": "ok",
        "deleted_player": {
            "id": player_id,
            "name": player.get("name") or f"Player {player_id}",
        },
        "cleanup": cleanup_summary,
    })


# ---------- API: Lists per player ----------

@app.route("/api/players/<int:player_id>/lists", methods=["POST"])
@login_required
def api_add_list(player_id):
    access_error = ensure_can_manage_player(player_id)
    if access_error:
        return access_error
    data = request.get_json()
    name = data.get("name", "").strip()
    text = data.get("text", "").strip()
    force_disposition = normalize_force_disposition(data.get("force_disposition"))
    if not name:
        return jsonify({"error": "List name is required"}), 400
    if not text:
        return jsonify({"error": "List text is required"}), 400
    if not force_disposition:
        return jsonify({"error": "Force disposition is required"}), 400

    players = load_players()
    for p in players:
        if p["id"] == player_id:
            p.setdefault("list_names", [])
            p.setdefault("list_force_dispositions", [])
            p["lists"].append(text)
            p["list_names"].append(name)
            p["list_force_dispositions"].append(force_disposition)
            # if it's the first list, make it default
            if p["default_index"] is None:
                p["default_index"] = 0
            save_players(players)
            total_lists = len(p.get("lists") or [])
            player_name = p.get("name") or f"Player {player_id}"
            send_discord_message(
                f"New battle plan uploaded by **{player_name}**. "
                f"Arsenal now holds {total_lists} list(s)."
            )
            return jsonify(p)
    return jsonify({"error": "Player not found"}), 404


@app.route("/api/players/<int:player_id>/lists/<int:list_index>", methods=["POST"])
@login_required
def api_update_list(player_id, list_index):
    access_error = ensure_can_manage_player(player_id)
    if access_error:
        return access_error
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    text = (data.get("text") or "").strip()
    force_disposition = normalize_force_disposition(data.get("force_disposition"))
    if not name:
        return jsonify({"error": "List name is required"}), 400
    if not text:
        return jsonify({"error": "List text is required"}), 400
    if not force_disposition:
        return jsonify({"error": "Force disposition is required"}), 400

    players = load_players()
    for p in players:
        if p["id"] == player_id:
            lists = p.get("lists") or []
            if not (0 <= list_index < len(lists)):
                return jsonify({"error": "List index out of range"}), 400

            p.setdefault("list_names", [])
            while len(p["list_names"]) < len(lists):
                p["list_names"].append(f"List #{len(p['list_names']) + 1}")
            p.setdefault("list_force_dispositions", [])
            while len(p["list_force_dispositions"]) < len(lists):
                p["list_force_dispositions"].append("")

            p["lists"][list_index] = text
            p["list_names"][list_index] = name
            p["list_force_dispositions"][list_index] = force_disposition
            save_players(players)
            return jsonify(p)
    return jsonify({"error": "Player not found"}), 404


@app.route("/api/players/<int:player_id>/lists/<int:list_index>", methods=["DELETE"])
@login_required
def api_delete_list(player_id, list_index):
    access_error = ensure_can_manage_player(player_id)
    if access_error:
        return access_error
    players = load_players()
    for p in players:
        if p["id"] == player_id:
            if 0 <= list_index < len(p["lists"]):
                p["lists"].pop(list_index)
                if isinstance(p.get("list_names"), list) and list_index < len(p["list_names"]):
                    p["list_names"].pop(list_index)
                if (
                    isinstance(p.get("list_force_dispositions"), list)
                    and list_index < len(p["list_force_dispositions"])
                ):
                    p["list_force_dispositions"].pop(list_index)
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
    access_error = ensure_can_manage_player(player_id)
    if access_error:
        return access_error
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


@app.route("/api/players/<int:player_id>/lists/<int:list_index>/name", methods=["POST"])
@login_required
def api_set_list_name(player_id, list_index):
    access_error = ensure_can_manage_player(player_id)
    if access_error:
        return access_error
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "List name is required"}), 400

    players = load_players()
    for p in players:
        if p["id"] == player_id:
            lists = p.get("lists") or []
            if not (0 <= list_index < len(lists)):
                return jsonify({"error": "List index out of range"}), 400

            p.setdefault("list_names", [])
            while len(p["list_names"]) < len(lists):
                p["list_names"].append(f"List #{len(p['list_names']) + 1}")
            p["list_names"][list_index] = name
            save_players(players)
            return jsonify(p)
    return jsonify({"error": "Player not found"}), 404


# ---------- API: Archetypes per player ----------

@app.route("/api/players/<int:player_id>/archetypes", methods=["POST"])
@login_required
def api_add_player_archetype(player_id):
    payload = request.get_json(silent=True) or {}
    faction = (payload.get("faction") or "").strip()
    role = (payload.get("role") or "").strip().lower()
    comment = (payload.get("comment") or "").strip()
    force_disposition = normalize_force_disposition(payload.get("force_disposition"))

    if not faction:
        return jsonify({"error": "Faction is required"}), 400
    if role not in ALLOWED_ARCHETYPE_ROLES:
        return jsonify({"error": "Role must be defense, attack, or blunt"}), 400
    if payload.get("force_disposition") and not force_disposition:
        return jsonify({"error": "Invalid force disposition"}), 400

    players = load_players()
    for p in players:
        if p.get("id") == player_id:
            archetypes = p.get("archetypes")
            if not isinstance(archetypes, list):
                archetypes = []
                p["archetypes"] = archetypes
            if len(archetypes) >= 3:
                return jsonify({"error": "Maximum 3 archetypes per player"}), 400
            archetypes.append({
                "faction": faction,
                "role": role,
                "force_disposition": force_disposition,
                "comment": comment
            })
            save_players(players)
            return jsonify(p)

    return jsonify({"error": "Player not found"}), 404


@app.route("/api/players/<int:player_id>/archetypes/<int:arch_index>", methods=["DELETE"])
@login_required
def api_delete_player_archetype(player_id, arch_index):
    players = load_players()
    for p in players:
        if p.get("id") == player_id:
            archetypes = p.get("archetypes")
            if not isinstance(archetypes, list):
                return jsonify({"error": "No archetypes to delete"}), 400
            if 0 <= arch_index < len(archetypes):
                archetypes.pop(arch_index)
                save_players(players)
                return jsonify(p)
            return jsonify({"error": "Archetype index out of range"}), 400
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
    normalized_armies = []
    for a in armies:
        faction = (a.get("faction") or "").strip()
        lst = (a.get("list") or "").strip()
        player_name = (a.get("player_name") or "").strip()
        force_disposition = normalize_force_disposition(a.get("force_disposition"))
        if not faction or not lst:
            return jsonify({"error": "Each army needs a faction and a list text"}), 400
        if not force_disposition:
            return jsonify({"error": "Each army needs a force disposition"}), 400
        if faction in seen_factions:
            return jsonify({"error": "Each faction must be unique (no duplicates)"}), 400
        seen_factions.add(faction)
        normalized_armies.append({
            "player_name": player_name,
            "faction": faction,
            "force_disposition": force_disposition,
            "list": lst,
        })

    games = load_games()
    new_game = {
        "id": next_game_id(games),
        "opponent_name": opponent_name,
        "armies": normalized_armies,
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
    game = load_game(game_id)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    roster = game.get("roster", [])
    roster_locked = isinstance(roster, list) and len(roster) > 0

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

    if not roster_ids:
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

    prev_matrix = game.get("matrix", {}) if isinstance(game.get("matrix"), dict) else {}
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

    armies = game.get("armies", [])
    expected = len(roster) * len(armies) if isinstance(roster, list) else 0
    prev_complete = expected > 0 and len(prev_matrix) == expected
    now_complete = expected > 0 and len(new_matrix) == expected
    if now_complete and not prev_complete:
        opp = game.get("opponent_name") or "Unknown opponent"
        send_discord_message(
            f"Matrix fully calibrated vs **{opp}**. "
            f"All {expected} matchups locked in."
        )

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

    prev_pairings = game.get("pairings", []) if isinstance(game.get("pairings"), list) else []
    prev_scenario = game.get("scenario")

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

    roster = game.get("roster") if isinstance(game.get("roster"), list) else []
    armies = game.get("armies") if isinstance(game.get("armies"), list) else []
    player_force_by_id = {
        entry.get("player_id"): normalize_force_disposition(entry.get("list_force_disposition"))
        for entry in roster
        if isinstance(entry, dict) and isinstance(entry.get("player_id"), int)
    }
    opponent_force_by_index = {
        index: normalize_force_disposition(army.get("force_disposition") if isinstance(army, dict) else "")
        for index, army in enumerate(armies)
    }

    for p in pairings:
        if not isinstance(p, dict):
            return jsonify({"error": "Invalid pairing entry"}), 400

        game_no = p.get("game_no")
        player_id = p.get("player_id")
        army_index = p.get("army_index")
        terrain_map_id_value = p.get("terrain_map_id")

        # allow empty slots
        if player_id is None or army_index is None:
            continue

        if not isinstance(game_no, int) or not (1 <= game_no <= 8):
            return jsonify({"error": "game_no must be 1..8"}), 400
        if not isinstance(player_id, int) or not isinstance(army_index, int):
            return jsonify({"error": "player_id and army_index must be int"}), 400

        if player_id in used_players:
            return jsonify({"error": "A player is used more than once"}), 400
        if army_index in used_armies:
            return jsonify({"error": "An opponent list is used more than once"}), 400

        if terrain_map_id_value is not None:
            if not isinstance(terrain_map_id_value, str) or not terrain_map_id_value.strip():
                return jsonify({"error": "terrain_map_id must be a non-empty string or null"}), 400

            our_force = player_force_by_id.get(player_id, "")
            opponent_force = opponent_force_by_index.get(army_index, "")
            if not valid_terrain_map_id(terrain_map_id_value, our_force, opponent_force):
                return jsonify({
                    "error": "terrain_map_id is not valid for this force disposition matchup"
                }), 400
            p["terrain_map_id"] = terrain_map_id_value.strip()
        
        real_score = p.get("real_score")
        if real_score is not None:
            if not isinstance(real_score, int) or not (0 <= real_score <= 20):
                return jsonify({"error": "real_score must be an integer between 0 and 20"}), 400


        used_players.add(player_id)
        used_armies.add(army_index)

    game["pairings"] = pairings
    save_games(games)

    opp = game.get("opponent_name") or "Unknown opponent"

    roster_map = {}
    roster = game.get("roster", [])
    if isinstance(roster, list):
        for p in roster:
            if isinstance(p, dict) and isinstance(p.get("player_id"), int):
                roster_map[p["player_id"]] = p.get("player_name") or f"Player {p['player_id']}"
    if not roster_map:
        players = load_players()
        roster_map = {p.get("id"): p.get("name") or f"Player {p.get('id')}" for p in players if isinstance(p, dict)}

    armies = game.get("armies", [])

    def describe_terrain_choice(pairing):
        player_id = pairing.get("player_id")
        army_index = pairing.get("army_index")
        terrain_id = pairing.get("terrain_map_id")
        if not isinstance(player_id, int) or not isinstance(army_index, int):
            return "—"
        if not isinstance(terrain_id, str) or not terrain_id.strip():
            return "Not selected"

        our_force = player_force_by_id.get(player_id, "")
        opponent_force = opponent_force_by_index.get(army_index, "")
        for option in terrain_options_for(our_force, opponent_force):
            if option["id"] == terrain_id.strip():
                return f"{option['combination']} · {option['label']}"
        return terrain_id.strip()

    def describe_pairing(pairing):
        player_id = pairing.get("player_id")
        army_index = pairing.get("army_index")
        player_name = roster_map.get(player_id, f"Player {player_id}")

        if isinstance(army_index, int) and 0 <= army_index < len(armies):
            army = armies[army_index]
            opp_player = (army.get("player_name") or "").strip() or f"Opponent #{army_index + 1}"
            faction = army.get("faction") or f"Army #{army_index + 1}"
        elif isinstance(army_index, int):
            opp_player = f"Opponent #{army_index + 1}"
            faction = f"Army #{army_index + 1}"
        else:
            opp_player = "Unknown opponent"
            faction = "Unknown Army"

        return player_name, opp_player, faction

    prev_by_game_no = {
        p.get("game_no"): p for p in prev_pairings
        if isinstance(p, dict) and isinstance(p.get("game_no"), int)
    }

    score_updates = []
    structure_changed = scenario is not None and prev_scenario != scenario

    for p in pairings:
        if not isinstance(p, dict):
            continue

        game_no = p.get("game_no")
        if not isinstance(game_no, int):
            continue

        prev = prev_by_game_no.get(game_no, {})
        if (
            p.get("player_id") != prev.get("player_id")
            or p.get("army_index") != prev.get("army_index")
            or p.get("layout_n") != prev.get("layout_n")
            or p.get("terrain_map_id") != prev.get("terrain_map_id")
        ):
            structure_changed = True

        new_score = p.get("real_score")
        prev_score = prev.get("real_score")
        if isinstance(new_score, int) and new_score != prev_score:
            score_updates.append((p, prev_score))

    if structure_changed and not score_updates:
        summary_lines = []
        for p in sorted(pairings, key=lambda x: x.get("game_no", 0)):
            player_id = p.get("player_id")
            army_index = p.get("army_index")
            if player_id is None or army_index is None:
                continue
            player_name, opp_player, faction = describe_pairing(p)
            terrain_text = describe_terrain_choice(p)
            summary_lines.append(
                f"G{p.get('game_no')}: {player_name} vs {opp_player} ({faction}) · Terrain: {terrain_text}"
            )

        summary_text = "\n".join(summary_lines) if summary_lines else "No matchups assigned yet."
        send_discord_message(
            f"Pairings saved vs **{opp}**.\n{summary_text}"
        )

    def count_scores(items):
        count = 0
        total = 0
        for entry in items:
            score = entry.get("real_score")
            if isinstance(score, int):
                count += 1
                total += score
        return count, total

    _, new_total = count_scores(pairings)
    for pairing, prev_score in score_updates:
        game_no = pairing.get("game_no")
        player_name, opp_player, faction = describe_pairing(pairing)
        score = pairing.get("real_score")
        action = "updated" if isinstance(prev_score, int) else "recorded"
        extra = ""
        scored_count, _ = count_scores(pairings)
        if scored_count == 8:
            if new_total < 75:
                verdict = "Loss"
            elif new_total <= 85:
                verdict = "Draw"
            else:
                verdict = "Win"
            extra = f" Team total: {new_total}/160 ({verdict})."

        send_discord_message(
            f"Result {action} vs **{opp}**: "
            f"G{game_no} · {player_name} vs {opp_player} ({faction}) · Score {score}/20.{extra}"
        )

    return jsonify({
        "status": "ok",
        "scenario": game.get("scenario"),
        "pairings": pairings
    })

@app.route("/api/games/<int:game_id>/pairings", methods=["GET"])
@login_required
def api_get_game_pairings(game_id):
    game = load_game(game_id)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    return jsonify({
        "scenario": game.get("scenario"),
        "pairings": game.get("pairings", [])
    })


@app.route("/api/games/<int:game_id>/fight-assistant", methods=["POST"])
@login_required
def api_fight_assistant(game_id):
    game = load_game(game_id)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    payload = request.get_json(silent=True) or {}
    pairings = payload.get("pairings", game.get("pairings", []))

    try:
        ctx = build_fight_solver_context(game, pairings)
    except ValueError as exc:
        message = str(exc)
        if message == "Matrix incomplete: some remaining cells are not filled":
            return jsonify({"error": message}), 400
        return jsonify({"error": message}), 400

    response = {
        "phase": ctx["phase"],
        "score_map": PAIRING_SCORE_MAP,
        "remaining_players": ctx["player_infos"],
        "remaining_armies": ctx["army_infos"],
        "our_best_defender": None,
        "guaranteed_score": None,
        "selected_our_defender": None,
        "selected_our_defender_score": None,
        "selected_enemy_defender": None,
        "suggested_attackers": [],
        "selected_enemy_attack_pair": [],
        "suggested_accept_enemy": None,
        "enemy_should_accept_our": None,
        "selected_enemy_accept_our": None,
        "refused_our_attacker": None,
        "refused_enemy_attacker": None,
        "our_leftover": None,
        "their_leftover": None,
        "projected_score": None,
        "next_phase": None,
        "next_our_defender": None,
        "next_guaranteed_score": None,
        "apply_plan": [],
    }

    if ctx["remaining_count"] == 0:
        response["guaranteed_score"] = 0.0
        return jsonify(response)

    remaining_locals = tuple(range(ctx["remaining_count"]))
    our_names = tuple(info["name"] for info in ctx["player_infos"])
    their_names = tuple(f"{info['player_name']} ({info['faction']})" for info in ctx["army_infos"])
    score_matrix_key = tuple(tuple(row) for row in ctx["score_matrix"])
    solver = get_cached_fight_solver(score_matrix_key, our_names, their_names)
    remaining_mask = solver._mask_from_indices(remaining_locals)
    summary = solver.recommend_defender(remaining_locals, remaining_locals)
    recommended_our_defender_local = summary["best_defender"]
    our_defender_local = recommended_our_defender_local
    response["our_best_defender"] = ctx["player_infos"][recommended_our_defender_local]
    response["guaranteed_score"] = round(summary["value"], 1)

    our_defender = payload.get("our_defender")
    if our_defender is not None:
        if not isinstance(our_defender, int):
            return jsonify({"error": "our_defender must be an integer"}), 400
        selected_local = ctx["local_player_by_id"].get(our_defender)
        if selected_local is None:
            return jsonify({"error": "Selected defender is not available in the current round."}), 400
        our_defender_local = selected_local

    selected_our_defender_score = compute_selected_defender_score(
        ctx,
        solver,
        remaining_locals,
        remaining_mask,
        our_defender_local,
    )
    response["selected_our_defender"] = ctx["player_infos"][our_defender_local]
    response["selected_our_defender_score"] = round(selected_our_defender_score, 1)

    enemy_defender = payload.get("enemy_defender")
    if enemy_defender is None:
        return jsonify(response)
    if not isinstance(enemy_defender, int):
        return jsonify({"error": "enemy_defender must be an integer"}), 400

    enemy_defender_local = ctx["local_army_by_index"].get(enemy_defender)
    if enemy_defender_local is None:
        return jsonify({"error": "Selected enemy defender is not available in the current round."}), 400

    response["selected_enemy_defender"] = ctx["army_infos"][enemy_defender_local]
    defender_detail = solve_defender_branch(
        ctx,
        solver,
        remaining_locals,
        our_defender_local,
        enemy_defender_local,
    )
    attack_pair_local = tuple(defender_detail["best_attack_pair"])
    response["suggested_attackers"] = [ctx["player_infos"][idx] for idx in attack_pair_local]

    enemy_attack_pair = payload.get("enemy_attack_pair")
    if enemy_attack_pair is None:
        return jsonify(response)
    if not isinstance(enemy_attack_pair, list):
        return jsonify({"error": "enemy_attack_pair must be a list"}), 400
    if len(enemy_attack_pair) != 2 or len(set(enemy_attack_pair)) != 2 or not all(isinstance(x, int) for x in enemy_attack_pair):
        return jsonify({"error": "enemy_attack_pair must contain exactly two distinct opponent armies"}), 400
    if enemy_defender in enemy_attack_pair:
        return jsonify({"error": "The enemy defender cannot also be part of the enemy attack pair."}), 400

    enemy_attack_pair_local = []
    for army_index in sorted(enemy_attack_pair):
        local_idx = ctx["local_army_by_index"].get(army_index)
        if local_idx is None:
            return jsonify({"error": "One selected enemy attacker is not available in the current round."}), 400
        enemy_attack_pair_local.append(local_idx)
    enemy_attack_pair_local = tuple(enemy_attack_pair_local)

    attack_detail = defender_detail["by_enemy_attack_pair"].get(enemy_attack_pair_local)
    if attack_detail is None:
        return jsonify({"error": "Invalid enemy attack pair for the current defender state."}), 400

    accepted_enemy_local = attack_detail["best_accept"]
    recommended_accepted_our_local = attack_detail["enemy_best_accept"]
    accepted_our_local = recommended_accepted_our_local
    accepted_our_attacker = payload.get("accepted_our_attacker")
    if accepted_our_attacker is not None:
        if not isinstance(accepted_our_attacker, int):
            return jsonify({"error": "accepted_our_attacker must be an integer"}), 400
        override_local = ctx["local_player_by_id"].get(accepted_our_attacker)
        if override_local is None or override_local not in attack_pair_local:
            return jsonify({"error": "accepted_our_attacker must be one of the suggested attackers."}), 400
        accepted_our_local = override_local

    refused_enemy_local = other_of_pair(enemy_attack_pair_local, accepted_enemy_local)
    refused_our_local = other_of_pair(attack_pair_local, accepted_our_local)

    response["selected_enemy_attack_pair"] = [ctx["army_infos"][idx] for idx in enemy_attack_pair_local]
    response["suggested_accept_enemy"] = ctx["army_infos"][accepted_enemy_local]
    response["enemy_should_accept_our"] = ctx["player_infos"][recommended_accepted_our_local]
    response["selected_enemy_accept_our"] = ctx["player_infos"][accepted_our_local]
    response["refused_enemy_attacker"] = ctx["army_infos"][refused_enemy_local]
    response["refused_our_attacker"] = ctx["player_infos"][refused_our_local]

    slot_numbers = ctx["phase"]["slot_numbers"]
    if ctx["remaining_count"] == 4:
        our_leftover_local = attack_detail["our_forgotten"]
        their_leftover_local = attack_detail["their_forgotten"]
        response["our_leftover"] = ctx["player_infos"][our_leftover_local]
        response["their_leftover"] = ctx["army_infos"][their_leftover_local]
        response["projected_score"] = round(
            solver.matchup_score(our_defender_local, accepted_enemy_local)
            + solver.matchup_score(accepted_our_local, enemy_defender_local)
            + solver.matchup_score(refused_our_local, refused_enemy_local)
            + solver.matchup_score(our_leftover_local, their_leftover_local),
            1,
        )
        response["next_phase"] = FIGHT_PHASE_BY_REMAINING[0]
        response["next_guaranteed_score"] = 0.0
        response["apply_plan"] = [
            build_solver_plan_item(slot_numbers[0], ctx["player_infos"][our_defender_local], ctx["army_infos"][accepted_enemy_local]),
            build_solver_plan_item(slot_numbers[1], ctx["player_infos"][accepted_our_local], ctx["army_infos"][enemy_defender_local]),
            build_solver_plan_item(slot_numbers[2], ctx["player_infos"][refused_our_local], ctx["army_infos"][refused_enemy_local]),
            build_solver_plan_item(slot_numbers[3], ctx["player_infos"][our_leftover_local], ctx["army_infos"][their_leftover_local]),
        ]
    else:
        next_ours = tuple(sorted(
            idx for idx in range(ctx["remaining_count"])
            if idx not in {our_defender_local, accepted_our_local}
        ))
        next_theirs = tuple(sorted(
            idx for idx in range(ctx["remaining_count"])
            if idx not in {enemy_defender_local, accepted_enemy_local}
        ))
        next_summary = solver.recommend_defender(next_ours, next_theirs)
        response["projected_score"] = round(
            solver.matchup_score(our_defender_local, accepted_enemy_local)
            + solver.matchup_score(accepted_our_local, enemy_defender_local)
            + next_summary["value"],
            1,
        )
        response["next_phase"] = FIGHT_PHASE_BY_REMAINING[len(next_ours)]
        response["next_our_defender"] = ctx["player_infos"][next_summary["best_defender"]]
        response["next_guaranteed_score"] = round(next_summary["value"], 1)
        response["apply_plan"] = [
            build_solver_plan_item(slot_numbers[0], ctx["player_infos"][our_defender_local], ctx["army_infos"][accepted_enemy_local]),
            build_solver_plan_item(slot_numbers[1], ctx["player_infos"][accepted_our_local], ctx["army_infos"][enemy_defender_local]),
        ]

    return jsonify(response)


@app.route("/api/games/<int:game_id>/fight-assistant-report", methods=["POST"])
@login_required
def api_fight_assistant_report(game_id):
    game = load_game(game_id)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    payload = request.get_json(silent=True) or {}
    pairings = payload.get("pairings", game.get("pairings", []))

    try:
        ctx = build_fight_solver_context(game, pairings)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    response = {
        "phase": ctx["phase"],
        "recommended_our_defender": None,
        "guaranteed_score": None,
        "selected_our_defender": None,
        "selected_our_defender_score": None,
        "scenario_count": 0,
        "displayed_scenario_count": 0,
        "scenarios": [],
        "report_text": "",
    }

    if ctx["remaining_count"] == 0:
        response["guaranteed_score"] = 0.0
        response["report_text"] = "Round complete.\nAll games are already assigned."
        return jsonify(response)

    remaining_locals = tuple(range(ctx["remaining_count"]))
    our_names = tuple(info["name"] for info in ctx["player_infos"])
    their_names = tuple(f"{info['player_name']} ({info['faction']})" for info in ctx["army_infos"])
    score_matrix_key = tuple(tuple(row) for row in ctx["score_matrix"])
    solver = get_cached_fight_solver(score_matrix_key, our_names, their_names)
    remaining_mask = solver._mask_from_indices(remaining_locals)
    summary = solver.recommend_defender(remaining_locals, remaining_locals)

    recommended_our_defender_local = summary["best_defender"]
    our_defender_local = recommended_our_defender_local

    report_first_defender_local = None
    report_first_defender = payload.get("report_first_defender")
    if report_first_defender is not None:
        if not isinstance(report_first_defender, int):
            return jsonify({"error": "report_first_defender must be an integer"}), 400
        report_first_defender_local = ctx["local_player_by_id"].get(report_first_defender)
        if report_first_defender_local is None:
            return jsonify({"error": "Forced first-defense player is not available in the current round."}), 400

    report_second_defender_local = None
    report_second_defender = payload.get("report_second_defender")
    if report_second_defender is not None:
        if not isinstance(report_second_defender, int):
            return jsonify({"error": "report_second_defender must be an integer"}), 400
        report_second_defender_local = ctx["local_player_by_id"].get(report_second_defender)
        if report_second_defender_local is None:
            return jsonify({"error": "Forced second-defense player is not available in the current round."}), 400

    report_enemy_first_defender_local = None
    report_enemy_first_defender = payload.get("report_enemy_first_defender")
    if report_enemy_first_defender is not None:
        if not isinstance(report_enemy_first_defender, int):
            return jsonify({"error": "report_enemy_first_defender must be an integer"}), 400
        report_enemy_first_defender_local = ctx["local_army_by_index"].get(report_enemy_first_defender)
        if report_enemy_first_defender_local is None:
            return jsonify({"error": "Forced opponent first-defense codex is not available in the current round."}), 400

    report_enemy_second_defender_local = None
    report_enemy_second_defender = payload.get("report_enemy_second_defender")
    if report_enemy_second_defender is not None:
        if not isinstance(report_enemy_second_defender, int):
            return jsonify({"error": "report_enemy_second_defender must be an integer"}), 400
        report_enemy_second_defender_local = ctx["local_army_by_index"].get(report_enemy_second_defender)
        if report_enemy_second_defender_local is None:
            return jsonify({"error": "Forced opponent second-defense codex is not available in the current round."}), 400

    our_defender = payload.get("our_defender")
    if our_defender is not None:
        if not isinstance(our_defender, int):
            return jsonify({"error": "our_defender must be an integer"}), 400
        selected_local = ctx["local_player_by_id"].get(our_defender)
        if selected_local is None:
            return jsonify({"error": "Selected defender is not available in the current round."}), 400
        our_defender_local = selected_local

    if ctx["remaining_count"] == 8 and report_first_defender_local is not None:
        our_defender_local = report_first_defender_local
    elif ctx["remaining_count"] == 6 and report_second_defender_local is not None:
        our_defender_local = report_second_defender_local

    selected_our_defender_score = compute_selected_defender_score(
        ctx,
        solver,
        remaining_locals,
        remaining_mask,
        our_defender_local,
    )

    response["recommended_our_defender"] = ctx["player_infos"][recommended_our_defender_local]
    response["guaranteed_score"] = round(summary["value"], 1)
    response["selected_our_defender"] = ctx["player_infos"][our_defender_local]
    response["selected_our_defender_score"] = round(selected_our_defender_score, 1)

    forced_our_defs_by_remaining = {}
    if ctx["remaining_count"] in {8, 6}:
        forced_our_defs_by_remaining[ctx["remaining_count"]] = our_defender_local
    if ctx["remaining_count"] == 8 and report_second_defender_local is not None:
        forced_our_defs_by_remaining[6] = report_second_defender_local

    forced_enemy_defs_by_remaining = {}
    if ctx["remaining_count"] == 8 and report_enemy_first_defender_local is not None:
        forced_enemy_defs_by_remaining[8] = report_enemy_first_defender_local
    if ctx["remaining_count"] in {8, 6} and report_enemy_second_defender_local is not None:
        forced_enemy_defs_by_remaining[6] = report_enemy_second_defender_local

    scenarios = build_mirror_scenarios(
        ctx,
        solver,
        remaining_locals,
        remaining_locals,
        forced_our_defs_by_remaining=forced_our_defs_by_remaining,
        forced_enemy_defs_by_remaining=forced_enemy_defs_by_remaining,
    )

    for scenario in scenarios:
        scenario["band"] = scenario_band(scenario["score"], selected_our_defender_score)

    scenarios.sort(key=lambda item: item["score"])

    response["scenario_count"] = len(scenarios)
    response["displayed_scenario_count"] = min(len(scenarios), MIRROR_REPORT_SCENARIO_LIMIT)
    response["scenarios"] = scenarios
    response["report_text"] = build_mirror_report_text(
        ctx,
        {
            "recommended_our_defender": ctx["player_infos"][recommended_our_defender_local],
            "guaranteed_score": round(summary["value"], 1),
        },
        ctx["player_infos"][our_defender_local],
        round(selected_our_defender_score, 1),
        scenarios,
        {
            "first_label": (
                format_report_player(ctx["player_infos"][report_first_defender_local])
                if report_first_defender_local is not None and ctx["remaining_count"] == 8
                else None
            ),
            "second_label": (
                format_report_player(ctx["player_infos"][report_second_defender_local])
                if report_second_defender_local is not None and ctx["remaining_count"] in {8, 6}
                else None
            ),
            "enemy_first_label": (
                format_report_army(ctx["army_infos"][report_enemy_first_defender_local])
                if report_enemy_first_defender_local is not None and ctx["remaining_count"] == 8
                else None
            ),
            "enemy_second_label": (
                format_report_army(ctx["army_infos"][report_enemy_second_defender_local])
                if report_enemy_second_defender_local is not None and ctx["remaining_count"] in {8, 6}
                else None
            ),
        },
    )
    return jsonify(response)


@app.route("/layouts/<path:filename>")
@login_required
def serve_layout(filename):
    # Serves data/HAX.png, etc.
    return send_from_directory(str(DATA_DIR), filename)


SCENARIO_PREFIX = {
    "HAMMER_ANVIL": "HA",
    "SEEK_DESTROY": "SD",
    "CRUCIBLE_BATTLE": "CB",
    "TIPPING_POINTS": "TD",
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


@app.route("/api/terrain-layouts", methods=["GET"])
@login_required
def api_list_terrain_layouts():
    return jsonify({
        "force_dispositions": FORCE_DISPOSITIONS,
        "maps_per_combination": TERRAIN_MAPS_PER_COMBINATION,
        "image_directory": "data/terrain",
        "filename_pattern": "{Your-Force}_vs_{Opponent-Force}_Layout-{A|B|C}.png",
        "supported_extensions": [ext.lstrip(".") for ext in TERRAIN_IMAGE_EXTENSIONS],
        "combinations": all_terrain_layouts(),
    })



@app.route("/api/games/<int:game_id>/optimize", methods=["GET"])
def api_optimize_pairing(game_id):
    games = load_games()
    game = next((g for g in games if g.get("id") == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    all_players = load_players()
    roster_ids = game.get("player_ids") or []

    by_id = {p.get("id"): p for p in all_players if isinstance(p, dict)}
    players = [by_id.get(pid) for pid in roster_ids]
    players = [p for p in players if p is not None]

    armies = game.get("armies", [])
    matrix = game.get("matrix", {})  # key "playerId-armyIndex" -> state

    if not players:
        return jsonify({"error": "Need at least 1 roster player"}), 400
    if len(armies) < len(players):
        return jsonify({
            "error": f"Need at least as many opponent codex as roster players ({len(armies)} vs {len(players)})"
        }), 400

    # Build score table score[i][j]
    score = []
    missing = []
    for i, p in enumerate(players):
        row = []
        for j in range(len(armies)):
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
    for perm in itertools.permutations(range(len(armies)), len(players)):  # perm[i] = army assigned to player i
        total = 0.0
        for i in range(len(players)):
            total += score[i][perm[i]]
        best.append((total, perm))

    best.sort(key=lambda x: x[0], reverse=True)
    top = best[:5]  # top 5 solutions

    def pack_solution(total, perm):
        pairings = []
        for i in range(len(players)):
            p = players[i]
            a_idx = perm[i]
            a = armies[a_idx]
            state = matrix.get(f"{p['id']}-{a_idx}")
            pairings.append({
                "player_id": p["id"],
                "player_name": p.get("name"),
                "army_index": a_idx,
                "faction": a.get("faction"),
                "force_disposition": normalize_force_disposition(a.get("force_disposition")),
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
    if isinstance(game.get("roster"), list) and len(game["roster"]) > 0:
        return jsonify({"error": "Roster already locked for this game"}), 400

    payload = request.get_json(silent=True) or {}
    player_ids = payload.get("player_ids")

    if not isinstance(player_ids, list) or not (1 <= len(player_ids) <= 8):
        return jsonify({"error": "Select between 1 and 8 players"}), 400
    if len(set(player_ids)) != len(player_ids) or not all(isinstance(x, int) for x in player_ids):
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
            "list_name": default_list_name(p),
            "list_force_disposition": default_force_disposition(p),
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

    state_to_expected = STATE_TO_SCORE

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
        roster = g.get("roster") or []
        roster_force_by_id = {
            entry.get("player_id"): normalize_force_disposition(entry.get("list_force_disposition"))
            for entry in roster
            if isinstance(entry, dict) and isinstance(entry.get("player_id"), int)
        }
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
                expected = state_to_expected.get(state) if state else None

            if isinstance(expected, (int, float)):
                d = float(real) - float(expected)
                row["sum_delta"] += d
                row["delta_count"] += 1
            else:
                d = None

            faction = None
            force_disposition = None
            terrain_label = None
            terrain_map_id_value = pr.get("terrain_map_id")
            if isinstance(aidx, int) and 0 <= aidx < len(armies):
                army = armies[aidx]
                faction = army.get("faction")
                force_disposition = normalize_force_disposition(army.get("force_disposition"))
                if isinstance(terrain_map_id_value, str) and terrain_map_id_value.strip():
                    our_force = roster_force_by_id.get(pid, "")
                    for option in terrain_options_for(our_force, force_disposition):
                        if option["id"] == terrain_map_id_value.strip():
                            terrain_label = f"{option['combination']} · {option['label']}"
                            break

            row["details"].append({
                "game_id": gid,
                "opponent": opp,
                "game_no": pr.get("game_no"),
                "faction": faction,
                "force_disposition": force_disposition,
                "scenario": scenario,
                "terrain_map_id": terrain_map_id_value if isinstance(terrain_map_id_value, str) else None,
                "terrain": terrain_label,
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
    p.setdefault("list_names", [])
    p.setdefault("default_index", None)
    p.setdefault("match_history", [])
    return jsonify(p)


@app.route("/api/players/<int:player_id>/matches", methods=["POST"])
@login_required
def api_add_player_match(player_id):
    payload = request.get_json(silent=True) or {}

    faction = (payload.get("faction") or "").strip()
    result = (payload.get("result") or "").strip().upper()  # WIN/DRAW/LOSS
    opponent_level = payload.get("opponent_level")
    player_force_disposition = normalize_force_disposition(payload.get("player_force_disposition"))
    opponent_force_disposition = normalize_force_disposition(payload.get("opponent_force_disposition"))
    comment = (payload.get("comment") or "").strip()

    if not faction:
        return jsonify({"error": "Faction is required"}), 400
    if result not in {"WIN", "DRAW", "LOSS"}:
        return jsonify({"error": "Result must be WIN, DRAW or LOSS"}), 400
    if not player_force_disposition:
        return jsonify({"error": "Your force disposition is required"}), 400
    if not opponent_force_disposition:
        return jsonify({"error": "Opponent force disposition is required"}), 400
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
        "player_force_disposition": player_force_disposition,
        "opponent_force_disposition": opponent_force_disposition,
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

    def get_default_list_name(player):
        snap_name = player.get("list_name")
        if isinstance(snap_name, str) and snap_name.strip():
            return snap_name.strip()
        return default_list_name(player)

    def get_default_force_disposition(player):
        snap_force = player.get("list_force_disposition")
        if isinstance(snap_force, str) and snap_force.strip():
            return normalize_force_disposition(snap_force)
        return default_force_disposition(player)

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
        list_name = get_default_list_name(p)
        force_disposition = get_default_force_disposition(p)
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
        header = f"{name} - {list_name}"
        if force_disposition:
            header = f"{header} - {force_disposition}"
        c.drawString(left_margin, y, header)
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
