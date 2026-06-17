create table if not exists public.profiles (
    id bigserial primary key,
    auth_user_id uuid not null unique,
    email text not null unique,
    display_name text
);

create table if not exists public.teams (
    id bigserial primary key,
    name text not null,
    slug text not null unique,
    password_hash text not null,
    created_by_profile_id bigint references public.profiles(id) on delete set null
);

create table if not exists public.players (
    id bigint primary key,
    team_id bigint not null references public.teams(id) on delete cascade,
    name text not null,
    active boolean not null default false,
    default_index integer
);

create index if not exists idx_players_team_id on public.players(team_id);

create table if not exists public.team_memberships (
    id bigserial primary key,
    team_id bigint not null references public.teams(id) on delete cascade,
    profile_id bigint not null references public.profiles(id) on delete cascade,
    role text not null check (role in ('captain', 'player')),
    player_id bigint references public.players(id) on delete set null,
    unique (team_id, profile_id)
);

create unique index if not exists idx_team_memberships_team_player_unique
on public.team_memberships(team_id, player_id)
where player_id is not null;

create table if not exists public.player_lists (
    id bigserial primary key,
    player_id bigint not null references public.players(id) on delete cascade,
    position integer not null,
    name text not null,
    list_text text not null,
    unique (player_id, position)
);

create table if not exists public.player_archetypes (
    id bigserial primary key,
    player_id bigint not null references public.players(id) on delete cascade,
    position integer not null,
    faction text not null,
    role text not null,
    comment text default '',
    unique (player_id, position)
);

create table if not exists public.games (
    id bigint primary key,
    team_id bigint not null references public.teams(id) on delete cascade,
    opponent_name text not null,
    armies jsonb not null default '[]'::jsonb,
    roster jsonb not null default '[]'::jsonb,
    matrix jsonb not null default '{}'::jsonb,
    pairings jsonb not null default '[]'::jsonb,
    scenario text,
    mission text default '',
    comment text default '',
    created_at text
);

create index if not exists idx_games_team_id on public.games(team_id);

create table if not exists public.calendar_items (
    id bigint primary key,
    team_id bigint not null references public.teams(id) on delete cascade,
    item_type text not null,
    title text not null,
    notes text default '',
    start_at text not null,
    end_at text not null,
    player_id bigint references public.players(id) on delete set null,
    game_id bigint references public.games(id) on delete set null,
    created_at text
);

create index if not exists idx_calendar_items_team_id on public.calendar_items(team_id);

create table if not exists public.team_settings (
    team_id bigint primary key references public.teams(id) on delete cascade,
    discord_webhook text default ''
);

create table if not exists public.team_friendships (
    id bigserial primary key,
    team_id bigint not null references public.teams(id) on delete cascade,
    friend_team_id bigint not null references public.teams(id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
    unique (team_id, friend_team_id),
    check (team_id <> friend_team_id)
);

create table if not exists public.team_share_policies (
    id bigserial primary key,
    source_team_id bigint not null references public.teams(id) on delete cascade,
    target_team_id bigint not null references public.teams(id) on delete cascade,
    resource_type text not null,
    access_level text not null default 'read' check (access_level in ('read', 'write')),
    unique (source_team_id, target_team_id, resource_type),
    check (source_team_id <> target_team_id)
);
