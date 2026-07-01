from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from typing import Any

from sqlalchemy import create_engine, text
from supabase import create_client
from werkzeug.security import check_password_hash, generate_password_hash


def slugify(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or "team"


def _as_json(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default
    return default


def _db_url() -> str:
    db_url = os.getenv("SUPABASE_DB_URL") or os.getenv("DATABASE_URL")
    if not db_url:
        raise RuntimeError("SUPABASE_DB_URL or DATABASE_URL must be configured.")
    if db_url.startswith("postgresql://"):
        return "postgresql+psycopg://" + db_url[len("postgresql://"):]
    if db_url.startswith("postgres://"):
        return "postgresql+psycopg://" + db_url[len("postgres://"):]
    return db_url


@lru_cache(maxsize=1)
def get_engine():
    return create_engine(_db_url(), future=True, pool_pre_ping=True)


@lru_cache(maxsize=1)
def ensure_player_match_history_column() -> None:
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                ALTER TABLE public.players
                ADD COLUMN IF NOT EXISTS match_history jsonb NOT NULL DEFAULT '[]'::jsonb
                """
            )
        )


@lru_cache(maxsize=1)
def get_supabase_client():
    url = os.getenv("SUPABASE_URL")
    anon_key = os.getenv("SUPABASE_ANON_KEY")
    if not url or not anon_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY must be configured.")
    return create_client(url, anon_key)


def next_public_id(table_name: str) -> int:
    allowed = {"players", "games", "calendar_items"}
    if table_name not in allowed:
        raise ValueError(f"Unsupported table name: {table_name}")

    engine = get_engine()
    with engine.connect() as conn:
        result = conn.execute(text(f"SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM {table_name}"))
        return int(result.scalar_one())


def list_public_teams(limit: int = 200) -> list[dict[str, Any]]:
    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT id, name, slug
                FROM teams
                ORDER BY lower(name), id
                LIMIT :limit
                """
            ),
            {"limit": limit},
        ).mappings()
        return [dict(row) for row in rows]


def ensure_profile(auth_user_id: str, email: str, display_name: str | None = None) -> dict[str, Any]:
    engine = get_engine()
    normalized_email = (email or "").strip().lower()
    display_name = (display_name or "").strip() or None

    with engine.begin() as conn:
        existing = conn.execute(
            text(
                """
                SELECT id, auth_user_id, email, display_name
                FROM profiles
                WHERE auth_user_id = :auth_user_id
                """
            ),
            {"auth_user_id": auth_user_id},
        ).mappings().first()

        if existing:
            conn.execute(
                text(
                    """
                    UPDATE profiles
                    SET email = :email,
                        display_name = COALESCE(:display_name, display_name)
                    WHERE auth_user_id = :auth_user_id
                    """
                ),
                {
                    "auth_user_id": auth_user_id,
                    "email": normalized_email,
                    "display_name": display_name,
                },
            )
        else:
            conn.execute(
                text(
                    """
                    INSERT INTO profiles (auth_user_id, email, display_name)
                    VALUES (:auth_user_id, :email, :display_name)
                    """
                ),
                {
                    "auth_user_id": auth_user_id,
                    "email": normalized_email,
                    "display_name": display_name,
                },
            )

        row = conn.execute(
            text(
                """
                SELECT id, auth_user_id, email, display_name
                FROM profiles
                WHERE auth_user_id = :auth_user_id
                """
            ),
            {"auth_user_id": auth_user_id},
        ).mappings().first()
        return dict(row) if row else {}


def get_team_by_slug_or_name(value: str) -> dict[str, Any] | None:
    token = (value or "").strip()
    if not token:
        return None

    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(
            text(
                """
                SELECT id, name, slug, password_hash
                FROM teams
                WHERE slug = :token OR lower(name) = lower(:token)
                ORDER BY id
                LIMIT 1
                """
            ),
            {"token": token},
        ).mappings().first()
        return dict(row) if row else None


def _list_memberships(conn, profile_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        text(
            """
            SELECT
                tm.id,
                tm.team_id,
                tm.role,
                tm.player_id,
                t.name AS team_name,
                t.slug AS team_slug,
                p.name AS player_name
            FROM team_memberships tm
            JOIN teams t ON t.id = tm.team_id
            LEFT JOIN players p ON p.id = tm.player_id
            WHERE tm.profile_id = :profile_id
            ORDER BY lower(t.name), tm.id
            """
        ),
        {"profile_id": profile_id},
    ).mappings()
    return [dict(row) for row in rows]


def get_auth_context(auth_user_id: str | None, membership_id: int | None = None) -> dict[str, Any]:
    base = {
        "authenticated": False,
        "ready": False,
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

    if not auth_user_id:
        return base

    engine = get_engine()
    with engine.connect() as conn:
        profile = conn.execute(
            text(
                """
                SELECT id, auth_user_id, email, display_name
                FROM profiles
                WHERE auth_user_id = :auth_user_id
                """
            ),
            {"auth_user_id": auth_user_id},
        ).mappings().first()

        if not profile:
            return base

        memberships = _list_memberships(conn, int(profile["id"]))
        active_membership = None
        if membership_id is not None:
            for item in memberships:
                if int(item["id"]) == int(membership_id):
                    active_membership = item
                    break
        if active_membership is None and memberships:
            active_membership = memberships[0]

        context = dict(base)
        context.update(
            {
                "authenticated": True,
                "auth_user_id": profile["auth_user_id"],
                "profile_id": int(profile["id"]),
                "email": profile["email"],
                "display_name": profile["display_name"],
                "memberships": memberships,
            }
        )

        if active_membership:
            context.update(
                {
                    "ready": True,
                    "membership_id": int(active_membership["id"]),
                    "team_id": int(active_membership["team_id"]),
                    "team_name": active_membership["team_name"],
                    "team_slug": active_membership["team_slug"],
                    "role": active_membership["role"],
                    "player_id": active_membership["player_id"],
                    "player_name": active_membership["player_name"],
                }
            )

        return context


def create_team(profile_id: int, team_name: str, team_password: str) -> dict[str, Any]:
    team_name = (team_name or "").strip()
    if not team_name:
        raise ValueError("Team name is required.")
    if not team_password:
        raise ValueError("Team password is required.")

    engine = get_engine()
    base_slug = slugify(team_name)

    with engine.begin() as conn:
        slug = base_slug
        suffix = 2
        while conn.execute(
            text("SELECT 1 FROM teams WHERE slug = :slug"),
            {"slug": slug},
        ).first():
            slug = f"{base_slug}-{suffix}"
            suffix += 1

        conn.execute(
            text(
                """
                INSERT INTO teams (name, slug, password_hash, created_by_profile_id)
                VALUES (:name, :slug, :password_hash, :profile_id)
                """
            ),
            {
                "name": team_name,
                "slug": slug,
                "password_hash": generate_password_hash(team_password),
                "profile_id": profile_id,
            },
        )

        team = conn.execute(
            text(
                """
                SELECT id, name, slug
                FROM teams
                WHERE slug = :slug
                """
            ),
            {"slug": slug},
        ).mappings().first()
        return dict(team) if team else {}


def _default_player_name(profile: dict[str, Any]) -> str:
    display_name = (profile.get("display_name") or "").strip()
    if display_name:
        return display_name
    email = (profile.get("email") or "").strip().lower()
    if email and "@" in email:
        return email.split("@", 1)[0]
    return f"Player {profile['id']}"


def _resolve_player_for_membership(
    conn,
    team_id: int,
    profile: dict[str, Any],
    existing_player_id: int | None = None,
) -> int:
    player_name = _default_player_name(profile)
    profile_id = int(profile["id"])

    if existing_player_id is not None:
        conn.execute(
            text(
                """
                UPDATE players
                SET name = :player_name
                WHERE team_id = :team_id
                  AND id = :player_id
                """
            ),
            {
                "team_id": team_id,
                "player_id": existing_player_id,
                "player_name": player_name,
            },
        )
        return existing_player_id

    matching_players = list(
        conn.execute(
            text(
                """
                SELECT id, name
                FROM players
                WHERE team_id = :team_id
                  AND lower(name) = lower(:player_name)
                ORDER BY id
                """
            ),
            {"team_id": team_id, "player_name": player_name},
        ).mappings()
    )

    if len(matching_players) > 1:
        raise ValueError(
            "Several players already match this name. Ask a captain to rename duplicates first."
        )

    if matching_players:
        player_id = int(matching_players[0]["id"])
        linked = conn.execute(
            text(
                """
                SELECT profile_id
                FROM team_memberships
                WHERE team_id = :team_id
                  AND player_id = :player_id
                  AND profile_id <> :profile_id
                LIMIT 1
                """
            ),
            {"team_id": team_id, "player_id": player_id, "profile_id": profile_id},
        ).first()
        if linked:
            raise ValueError("This player is already linked to another account.")
        return player_id

    player_id = next_public_id("players")
    conn.execute(
        text(
            """
            INSERT INTO players (id, team_id, name, default_index)
            VALUES (:id, :team_id, :name, NULL)
            """
        ),
        {
            "id": player_id,
            "team_id": team_id,
            "name": player_name,
        },
    )
    return player_id


def join_team(profile_id: int, team_id: int, team_password: str, role: str) -> dict[str, Any]:
    role = (role or "").strip().lower()
    if role not in {"captain", "player"}:
        raise ValueError("Role must be captain or player.")

    engine = get_engine()
    with engine.begin() as conn:
        profile = conn.execute(
            text(
                """
                SELECT id, email, display_name
                FROM profiles
                WHERE id = :profile_id
                """
            ),
            {"profile_id": profile_id},
        ).mappings().first()
        if not profile:
            raise ValueError("Profile not found.")

        team = conn.execute(
            text(
                """
                SELECT id, password_hash
                FROM teams
                WHERE id = :team_id
                """
            ),
            {"team_id": team_id},
        ).mappings().first()
        if not team:
            raise ValueError("Team not found.")
        if not check_password_hash(team["password_hash"], team_password or ""):
            raise ValueError("Invalid team password.")

        existing = conn.execute(
            text(
                """
                SELECT id, role, player_id
                FROM team_memberships
                WHERE team_id = :team_id
                  AND profile_id = :profile_id
                """
            ),
            {"team_id": team_id, "profile_id": profile_id},
        ).mappings().first()

        player_id = _resolve_player_for_membership(
            conn,
            team_id,
            dict(profile),
            int(existing["player_id"]) if existing and existing.get("player_id") is not None else None,
        )

        if existing:
            conn.execute(
                text(
                    """
                    UPDATE team_memberships
                    SET role = :role,
                        player_id = :player_id
                    WHERE id = :membership_id
                    """
                ),
                {
                    "membership_id": existing["id"],
                    "role": role,
                    "player_id": player_id,
                },
            )
            membership_id = int(existing["id"])
        else:
            conn.execute(
                text(
                    """
                    INSERT INTO team_memberships (team_id, profile_id, role, player_id)
                    VALUES (:team_id, :profile_id, :role, :player_id)
                    """
                ),
                {
                    "team_id": team_id,
                    "profile_id": profile_id,
                    "role": role,
                    "player_id": player_id,
                },
            )
            membership_id = int(
                conn.execute(text("SELECT currval(pg_get_serial_sequence('team_memberships', 'id'))")).scalar_one()
            )

        membership = conn.execute(
            text(
                """
                SELECT id, team_id, profile_id, role, player_id
                FROM team_memberships
                WHERE id = :membership_id
                """
            ),
            {"membership_id": membership_id},
        ).mappings().first()
        return dict(membership) if membership else {}


def select_membership(auth_user_id: str, membership_id: int) -> dict[str, Any]:
    context = get_auth_context(auth_user_id, membership_id)
    if not context["ready"] or int(context["membership_id"]) != int(membership_id):
        raise ValueError("Membership not found.")
    return context


def _unique_team_slug(conn, team_name: str, team_id: int | None = None) -> str:
    base_slug = slugify(team_name)
    slug = base_slug
    suffix = 2

    while True:
        params: dict[str, Any] = {"slug": slug}
        query = "SELECT 1 FROM teams WHERE slug = :slug"
        if team_id is not None:
            query += " AND id <> :team_id"
            params["team_id"] = team_id
        if not conn.execute(text(query), params).first():
            return slug
        slug = f"{base_slug}-{suffix}"
        suffix += 1


def _membership_list(value: Any) -> list[dict[str, Any]]:
    memberships = _as_json(value, [])
    if not isinstance(memberships, list):
        return []
    return [item for item in memberships if isinstance(item, dict)]


def admin_overview() -> dict[str, Any]:
    engine = get_engine()
    with engine.connect() as conn:
        team_rows = conn.execute(
            text(
                """
                SELECT
                    t.id,
                    t.name,
                    t.slug,
                    t.created_by_profile_id,
                    creator.email AS created_by_email,
                    (SELECT count(*) FROM team_memberships tm WHERE tm.team_id = t.id) AS member_count,
                    (SELECT count(*) FROM players p WHERE p.team_id = t.id) AS player_count,
                    (SELECT count(*) FROM games g WHERE g.team_id = t.id) AS game_count,
                    (SELECT count(*) FROM calendar_items ci WHERE ci.team_id = t.id) AS calendar_count
                FROM teams t
                LEFT JOIN profiles creator ON creator.id = t.created_by_profile_id
                ORDER BY lower(t.name), t.id
                """
            )
        ).mappings()

        teams = [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "slug": row["slug"],
                "created_by_profile_id": (
                    int(row["created_by_profile_id"])
                    if row["created_by_profile_id"] is not None
                    else None
                ),
                "created_by_email": row["created_by_email"],
                "member_count": int(row["member_count"] or 0),
                "player_count": int(row["player_count"] or 0),
                "game_count": int(row["game_count"] or 0),
                "calendar_count": int(row["calendar_count"] or 0),
            }
            for row in team_rows
        ]

        profile_rows = conn.execute(
            text(
                """
                SELECT
                    p.id,
                    p.auth_user_id,
                    p.email,
                    p.display_name,
                    (
                        SELECT json_agg(
                            json_build_object(
                                'id', tm.id,
                                'team_id', tm.team_id,
                                'team_name', t.name,
                                'team_slug', t.slug,
                                'role', tm.role,
                                'player_id', tm.player_id,
                                'player_name', pl.name
                            )
                            ORDER BY lower(t.name), tm.id
                        )
                        FROM team_memberships tm
                        JOIN teams t ON t.id = tm.team_id
                        LEFT JOIN players pl ON pl.id = tm.player_id
                        WHERE tm.profile_id = p.id
                    ) AS memberships
                FROM profiles p
                ORDER BY lower(p.email), p.id
                """
            )
        ).mappings()

        profiles = []
        for row in profile_rows:
            memberships = _membership_list(row["memberships"])
            profiles.append(
                {
                    "id": int(row["id"]),
                    "auth_user_id": str(row["auth_user_id"]),
                    "email": row["email"],
                    "display_name": row["display_name"],
                    "membership_count": len(memberships),
                    "memberships": [
                        {
                            "id": int(item["id"]),
                            "team_id": int(item["team_id"]),
                            "team_name": item.get("team_name"),
                            "team_slug": item.get("team_slug"),
                            "role": item.get("role"),
                            "player_id": (
                                int(item["player_id"])
                                if item.get("player_id") is not None
                                else None
                            ),
                            "player_name": item.get("player_name"),
                        }
                        for item in memberships
                    ],
                }
            )

        return {"teams": teams, "profiles": profiles}


def admin_rename_team(team_id: int, team_name: str) -> dict[str, Any]:
    team_name = (team_name or "").strip()
    if not team_name:
        raise ValueError("Team name is required.")

    engine = get_engine()
    with engine.begin() as conn:
        existing = conn.execute(
            text("SELECT id FROM teams WHERE id = :team_id"),
            {"team_id": team_id},
        ).first()
        if not existing:
            raise ValueError("Team not found.")

        slug = _unique_team_slug(conn, team_name, team_id)
        row = conn.execute(
            text(
                """
                UPDATE teams
                SET name = :name,
                    slug = :slug
                WHERE id = :team_id
                RETURNING id, name, slug
                """
            ),
            {"team_id": team_id, "name": team_name, "slug": slug},
        ).mappings().first()
        return dict(row) if row else {}


def admin_delete_team(team_id: int) -> dict[str, Any]:
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT id, name, slug FROM teams WHERE id = :team_id"),
            {"team_id": team_id},
        ).mappings().first()
        if not row:
            raise ValueError("Team not found.")

        conn.execute(
            text("DELETE FROM teams WHERE id = :team_id"),
            {"team_id": team_id},
        )
        return dict(row)


def admin_rename_profile(profile_id: int, display_name: str) -> dict[str, Any]:
    display_name = (display_name or "").strip()
    if not display_name:
        raise ValueError("Display name is required.")

    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            text(
                """
                UPDATE profiles
                SET display_name = :display_name
                WHERE id = :profile_id
                RETURNING id, email, display_name
                """
            ),
            {"profile_id": profile_id, "display_name": display_name},
        ).mappings().first()
        if not row:
            raise ValueError("User not found.")

        conn.execute(
            text(
                """
                UPDATE players p
                SET name = :display_name
                FROM team_memberships tm
                WHERE tm.player_id = p.id
                  AND tm.profile_id = :profile_id
                """
            ),
            {"profile_id": profile_id, "display_name": display_name},
        )
        return dict(row)


def admin_delete_profile(profile_id: int) -> dict[str, Any]:
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT id, email, display_name FROM profiles WHERE id = :profile_id"),
            {"profile_id": profile_id},
        ).mappings().first()
        if not row:
            raise ValueError("User not found.")

        conn.execute(
            text("DELETE FROM profiles WHERE id = :profile_id"),
            {"profile_id": profile_id},
        )
        return dict(row)


def admin_delete_membership(membership_id: int) -> dict[str, Any]:
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            text(
                """
                SELECT
                    tm.id,
                    tm.team_id,
                    tm.profile_id,
                    tm.role,
                    t.name AS team_name,
                    p.email AS email
                FROM team_memberships tm
                JOIN teams t ON t.id = tm.team_id
                JOIN profiles p ON p.id = tm.profile_id
                WHERE tm.id = :membership_id
                """
            ),
            {"membership_id": membership_id},
        ).mappings().first()
        if not row:
            raise ValueError("Membership not found.")

        conn.execute(
            text("DELETE FROM team_memberships WHERE id = :membership_id"),
            {"membership_id": membership_id},
        )
        return dict(row)


def load_players(team_id: int | None) -> list[dict[str, Any]]:
    if not team_id:
        return []

    ensure_player_match_history_column()

    engine = get_engine()
    with engine.connect() as conn:
        players = [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "lists": [],
                "list_names": [],
                "default_index": row["default_index"],
                "archetypes": [],
                "match_history": _as_json(row["match_history"], []),
            }
            for row in conn.execute(
                text(
                    """
                    SELECT id, name, default_index, match_history
                    FROM players
                    WHERE team_id = :team_id
                    ORDER BY id
                    """
                ),
                {"team_id": team_id},
            ).mappings()
        ]

        by_id = {player["id"]: player for player in players}

        for row in conn.execute(
            text(
                """
                SELECT pl.player_id, pl.position, pl.name, pl.list_text
                FROM player_lists pl
                JOIN players p ON p.id = pl.player_id
                WHERE p.team_id = :team_id
                ORDER BY pl.player_id, pl.position
                """
            ),
            {"team_id": team_id},
        ).mappings():
            player = by_id.get(int(row["player_id"]))
            if player is None:
                continue
            player["list_names"].append(row["name"])
            player["lists"].append(row["list_text"])

        for row in conn.execute(
            text(
                """
                SELECT pa.player_id, pa.position, pa.faction, pa.role, pa.comment
                FROM player_archetypes pa
                JOIN players p ON p.id = pa.player_id
                WHERE p.team_id = :team_id
                ORDER BY pa.player_id, pa.position
                """
            ),
            {"team_id": team_id},
        ).mappings():
            player = by_id.get(int(row["player_id"]))
            if player is None:
                continue
            player["archetypes"].append(
                {
                    "faction": row["faction"],
                    "role": row["role"],
                    "comment": row["comment"] or "",
                }
            )

        return players


def _game_from_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "opponent_name": row["opponent_name"],
        "armies": _as_json(row["armies"], []),
        "roster": _as_json(row["roster"], []),
        "matrix": _as_json(row["matrix"], {}),
        "pairings": _as_json(row["pairings"], []),
        "scenario": row["scenario"],
        "mission": row["mission"] or "",
        "comment": row["comment"] or "",
        "created_at": row["created_at"],
    }


def load_game(team_id: int | None, game_id: int) -> dict[str, Any] | None:
    if not team_id:
        return None

    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(
            text(
                """
                SELECT id, opponent_name, armies, roster, matrix, pairings, scenario, mission, comment, created_at
                FROM games
                WHERE team_id = :team_id AND id = :game_id
                LIMIT 1
                """
            ),
            {"team_id": team_id, "game_id": game_id},
        ).mappings().first()
        return _game_from_row(row) if row else None


def save_players(team_id: int | None, players: list[dict[str, Any]]) -> None:
    if not team_id:
        raise RuntimeError("Active team is required.")

    ensure_player_match_history_column()

    engine = get_engine()
    with engine.begin() as conn:
        existing_ids = {
            int(row["id"])
            for row in conn.execute(
                text("SELECT id FROM players WHERE team_id = :team_id"),
                {"team_id": team_id},
            ).mappings()
        }

        incoming_ids = {int(player["id"]) for player in players if isinstance(player.get("id"), int)}
        removed_ids = existing_ids - incoming_ids

        for player_id in removed_ids:
            conn.execute(
                text("DELETE FROM players WHERE team_id = :team_id AND id = :player_id"),
                {"team_id": team_id, "player_id": player_id},
            )

        for player in players:
            player_id = int(player["id"])
            payload = {
                "id": player_id,
                "team_id": team_id,
                "name": (player.get("name") or "").strip(),
                "default_index": player.get("default_index"),
                "match_history": json.dumps(player.get("match_history") or []),
            }

            if player_id in existing_ids:
                conn.execute(
                    text(
                        """
                        UPDATE players
                        SET name = :name,
                            default_index = :default_index,
                            match_history = CAST(:match_history AS jsonb)
                        WHERE team_id = :team_id AND id = :id
                        """
                    ),
                    payload,
                )
            else:
                conn.execute(
                    text(
                        """
                        INSERT INTO players (id, team_id, name, default_index, match_history)
                        VALUES (:id, :team_id, :name, :default_index, CAST(:match_history AS jsonb))
                        """
                    ),
                    payload,
                )
                existing_ids.add(player_id)

            conn.execute(
                text("DELETE FROM player_lists WHERE player_id = :player_id"),
                {"player_id": player_id},
            )
            conn.execute(
                text("DELETE FROM player_archetypes WHERE player_id = :player_id"),
                {"player_id": player_id},
            )

            list_names = player.get("list_names") or []
            lists = player.get("lists") or []
            for idx, text_value in enumerate(lists):
                conn.execute(
                    text(
                        """
                        INSERT INTO player_lists (player_id, position, name, list_text)
                        VALUES (:player_id, :position, :name, :list_text)
                        """
                    ),
                    {
                        "player_id": player_id,
                        "position": idx,
                        "name": (list_names[idx] if idx < len(list_names) else f"List #{idx + 1}").strip(),
                        "list_text": text_value,
                    },
                )

            archetypes = player.get("archetypes") or []
            for idx, archetype in enumerate(archetypes):
                conn.execute(
                    text(
                        """
                        INSERT INTO player_archetypes (player_id, position, faction, role, comment)
                        VALUES (:player_id, :position, :faction, :role, :comment)
                        """
                    ),
                    {
                        "player_id": player_id,
                        "position": idx,
                        "faction": (archetype.get("faction") or "").strip(),
                        "role": (archetype.get("role") or "").strip(),
                        "comment": (archetype.get("comment") or "").strip(),
                    },
                )


def load_games(team_id: int | None) -> list[dict[str, Any]]:
    if not team_id:
        return []

    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT id, opponent_name, armies, roster, matrix, pairings, scenario, mission, comment, created_at
                FROM games
                WHERE team_id = :team_id
                ORDER BY id
                """
            ),
            {"team_id": team_id},
        ).mappings()

        games = []
        for row in rows:
            games.append(_game_from_row(row))
        return games


def save_games(team_id: int | None, games: list[dict[str, Any]]) -> None:
    if not team_id:
        raise RuntimeError("Active team is required.")

    engine = get_engine()
    with engine.begin() as conn:
        existing_ids = {
            int(row["id"])
            for row in conn.execute(
                text("SELECT id FROM games WHERE team_id = :team_id"),
                {"team_id": team_id},
            ).mappings()
        }

        incoming_ids = {int(game["id"]) for game in games if isinstance(game.get("id"), int)}
        removed_ids = existing_ids - incoming_ids
        for game_id in removed_ids:
            conn.execute(
                text("DELETE FROM games WHERE team_id = :team_id AND id = :game_id"),
                {"team_id": team_id, "game_id": game_id},
            )

        for game in games:
            game_id = int(game["id"])
            payload = {
                "id": game_id,
                "team_id": team_id,
                "opponent_name": (game.get("opponent_name") or "").strip(),
                "armies": json.dumps(game.get("armies") or []),
                "roster": json.dumps(game.get("roster") or []),
                "matrix": json.dumps(game.get("matrix") or {}),
                "pairings": json.dumps(game.get("pairings") or []),
                "scenario": game.get("scenario"),
                "mission": (game.get("mission") or "").strip(),
                "comment": (game.get("comment") or "").strip(),
                "created_at": game.get("created_at"),
            }

            if game_id in existing_ids:
                conn.execute(
                    text(
                        """
                        UPDATE games
                        SET opponent_name = :opponent_name,
                            armies = CAST(:armies AS jsonb),
                            roster = CAST(:roster AS jsonb),
                            matrix = CAST(:matrix AS jsonb),
                            pairings = CAST(:pairings AS jsonb),
                            scenario = :scenario,
                            mission = :mission,
                            comment = :comment,
                            created_at = :created_at
                        WHERE team_id = :team_id AND id = :id
                        """
                    ),
                    payload,
                )
            else:
                conn.execute(
                    text(
                        """
                        INSERT INTO games (
                            id, team_id, opponent_name, armies, roster, matrix, pairings, scenario, mission, comment, created_at
                        )
                        VALUES (
                            :id, :team_id, :opponent_name, CAST(:armies AS jsonb), CAST(:roster AS jsonb),
                            CAST(:matrix AS jsonb), CAST(:pairings AS jsonb), :scenario, :mission, :comment, :created_at
                        )
                        """
                    ),
                    payload,
                )
                existing_ids.add(game_id)


def load_settings(team_id: int | None) -> dict[str, Any]:
    if not team_id:
        return {}

    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(
            text(
                """
                SELECT discord_webhook
                FROM team_settings
                WHERE team_id = :team_id
                """
            ),
            {"team_id": team_id},
        ).mappings().first()
        if not row:
            return {}
        return {"discord_webhook": row["discord_webhook"] or ""}


def save_settings(team_id: int | None, settings: dict[str, Any]) -> None:
    if not team_id:
        raise RuntimeError("Active team is required.")

    engine = get_engine()
    with engine.begin() as conn:
        exists = conn.execute(
            text("SELECT 1 FROM team_settings WHERE team_id = :team_id"),
            {"team_id": team_id},
        ).first()
        payload = {
            "team_id": team_id,
            "discord_webhook": (settings.get("discord_webhook") or "").strip(),
        }
        if exists:
            conn.execute(
                text(
                    """
                    UPDATE team_settings
                    SET discord_webhook = :discord_webhook
                    WHERE team_id = :team_id
                    """
                ),
                payload,
            )
        else:
            conn.execute(
                text(
                    """
                    INSERT INTO team_settings (team_id, discord_webhook)
                    VALUES (:team_id, :discord_webhook)
                    """
                ),
                payload,
            )


def load_calendar_items(team_id: int | None) -> list[dict[str, Any]]:
    if not team_id:
        return []

    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT id, item_type, title, notes, start_at, end_at, player_id, game_id, created_at
                FROM calendar_items
                WHERE team_id = :team_id
                ORDER BY id
                """
            ),
            {"team_id": team_id},
        ).mappings()

        return [
            {
                "id": int(row["id"]),
                "type": row["item_type"],
                "title": row["title"] or "",
                "notes": row["notes"] or "",
                "start": row["start_at"],
                "end": row["end_at"],
                "player_id": row["player_id"],
                "game_id": row["game_id"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]


def save_calendar_items(team_id: int | None, items: list[dict[str, Any]]) -> None:
    if not team_id:
        raise RuntimeError("Active team is required.")

    engine = get_engine()
    with engine.begin() as conn:
        existing_ids = {
            int(row["id"])
            for row in conn.execute(
                text("SELECT id FROM calendar_items WHERE team_id = :team_id"),
                {"team_id": team_id},
            ).mappings()
        }

        incoming_ids = {int(item["id"]) for item in items if isinstance(item.get("id"), int)}
        removed_ids = existing_ids - incoming_ids
        for item_id in removed_ids:
            conn.execute(
                text("DELETE FROM calendar_items WHERE team_id = :team_id AND id = :item_id"),
                {"team_id": team_id, "item_id": item_id},
            )

        for item in items:
            item_id = int(item["id"])
            payload = {
                "id": item_id,
                "team_id": team_id,
                "item_type": (item.get("type") or "").strip(),
                "title": (item.get("title") or "").strip(),
                "notes": (item.get("notes") or "").strip(),
                "start_at": item.get("start"),
                "end_at": item.get("end"),
                "player_id": item.get("player_id"),
                "game_id": item.get("game_id"),
                "created_at": item.get("created_at"),
            }

            if item_id in existing_ids:
                conn.execute(
                    text(
                        """
                        UPDATE calendar_items
                        SET item_type = :item_type,
                            title = :title,
                            notes = :notes,
                            start_at = :start_at,
                            end_at = :end_at,
                            player_id = :player_id,
                            game_id = :game_id,
                            created_at = :created_at
                        WHERE team_id = :team_id AND id = :id
                        """
                    ),
                    payload,
                )
            else:
                conn.execute(
                    text(
                        """
                        INSERT INTO calendar_items (
                            id, team_id, item_type, title, notes, start_at, end_at, player_id, game_id, created_at
                        )
                        VALUES (
                            :id, :team_id, :item_type, :title, :notes, :start_at, :end_at, :player_id, :game_id, :created_at
                        )
                        """
                    ),
                    payload,
                )
                existing_ids.add(item_id)
