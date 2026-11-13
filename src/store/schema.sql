-- Pnyx's own data. The server is the only writer; zero-cache replicates the tables of the pnyx_page publication to
-- the page.
-- Each `data` column holds the record as the server keeps it in memory. It is json, not jsonb, so key
-- order survives a reload. The typed columns beside it are copies the page filters and sorts on.

create table hydras (
  id text primary key check (id ~* '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- The last event's seq. A write moves it with UPDATE ... WHERE seq = <the seq it read>.
  seq bigint not null default 0 check (seq >= 0),
  -- HydraConfig without its columns, which have their own table. Null until Hydra is configured.
  config json,
  -- Facts the server derives for the page: the Hydra list's entry, and the queue box with the updates waiting for
  -- Hydra and the batch it is reading, which the server writes whenever they change.
  summary json not null,
  -- The size of the events.jsonl this Hydra was imported from, so a log an older Pnyx appended to since is refused.
  imported_bytes bigint check (imported_bytes > 0)
);

-- Live queue facts change independently of the Hydra's event sequence.
create table hydra_queues (
  hydra_id text primary key references hydras (id) on delete cascade,
  value json not null
);

-- The settings every Hydra shares, as the server last applied them.
create table settings (
  id text primary key check (id = 'shared'),
  revision integer not null check (revision >= 0),
  value json not null
);

-- The last upgrade check, so the page's upgrade notice survives a restart.
create table upgrade_status (
  id text primary key check (id = 'current'),
  available boolean not null,
  checked_at text not null
);

-- The HydraState fields without a table of their own, one row each. keys and eventIds are rebuilt from cards and
-- events on load.
create table hydra_values (
  hydra_id text not null references hydras (id) on delete cascade,
  key text not null,
  value json not null,
  primary key (hydra_id, key)
);

-- Every change, in order: a card's Updates tab and the history commands read it.
create table events (
  hydra_id text not null references hydras (id) on delete cascade,
  seq bigint not null check (seq > 0),
  id text not null,
  type text not null,
  at text not null,
  actor text not null,
  card_id text not null,
  data json not null,
  primary key (hydra_id, seq),
  unique (hydra_id, id)
);

create index events_card_history on events (hydra_id, card_id, seq);
create index events_type_history on events (hydra_id, type, seq);

-- Latest source watermarks reject delayed reports across restarts without recording repeat events.
create table source_observations (
  hydra_id text not null references hydras (id) on delete cascade,
  card_id text not null,
  adapter text not null,
  instance_id text not null,
  object_id text not null,
  generation double precision not null check (generation >= 0),
  observed_at text not null,
  seen_at text not null,
  primary key (hydra_id, card_id, adapter, instance_id, object_id)
);

-- Each card's Updates tab: the events it lists, which can be listed by several cards, as a message to Hydra is by
-- its task and every task it mentions.
create table card_updates (
  hydra_id text not null,
  card_id text not null,
  seq bigint not null,
  primary key (hydra_id, card_id, seq),
  foreign key (hydra_id, seq) references events (hydra_id, seq) on delete cascade
);

create index card_updates_event on card_updates (hydra_id, seq);

-- An applied plan's receipt under its id, so the same plan sent again returns it instead of applying twice.
create table transactions (
  hydra_id text not null references hydras (id) on delete cascade,
  id text not null,
  digest text not null,
  receipt json not null,
  primary key (hydra_id, id)
);

create table columns (
  hydra_id text not null references hydras (id) on delete cascade,
  id text not null,
  position integer not null check (position >= 0),
  title text not null,
  role text,
  data json not null,
  primary key (hydra_id, id),
  unique (hydra_id, position) deferrable initially deferred
);

-- A card's identity and the fields the page filters on; the whole card is in card_bodies.
create table cards (
  hydra_id text not null references hydras (id) on delete cascade,
  id text not null,
  key text not null,
  title text not null,
  column_id text not null,
  rank double precision,
  parent_id text,
  project text,
  kind text check (kind in ('build', 'investigation')),
  status text check (status in ('working', 'needs_you', 'paused', 'blocked', 'done')),
  hidden boolean not null,
  automatic_task boolean not null,
  done_at text,
  created_seq bigint not null,
  updated_seq bigint not null,
  updated_at text not null,
  -- Facts that read other cards, which the server derives on every change.
  child_working boolean not null,
  wait_title text,
  unmet_prerequisites json not null,
  primary key (hydra_id, id),
  unique (hydra_id, key)
);

create table card_bodies (
  hydra_id text not null,
  card_id text not null,
  -- The card without the records the tables below hold.
  data json not null,
  primary key (hydra_id, card_id),
  foreign key (hydra_id, card_id) references cards (hydra_id, id) on delete cascade
);

-- The card fields the page never sees, queued steering and external source claims, for a card that has any. Outside
-- the page's publication, so zero-cache never replicates this table; the events that recorded them replicate, and no
-- page query reads those events.
create table card_private (
  hydra_id text not null,
  card_id text not null,
  data json not null,
  primary key (hydra_id, card_id),
  foreign key (hydra_id, card_id) references cards (hydra_id, id) on delete cascade
);

-- What a hidden task's chips, waits and answer leads read: the card without its histories, texts and worker setup,
-- and only its newest questions and links. Only the page's task references read it.
create table card_references (
  hydra_id text not null,
  card_id text not null,
  data json not null,
  primary key (hydra_id, card_id),
  foreign key (hydra_id, card_id) references cards (hydra_id, id) on delete cascade
);

-- The messages sent to a card's worker, with each one's delivery. The page reads the newest that answer a question.
create table replies (
  hydra_id text not null,
  card_id text not null,
  id text not null,
  position integer not null check (position >= 0),
  answers text,
  data json not null,
  primary key (hydra_id, card_id, id),
  foreign key (hydra_id, card_id) references cards (hydra_id, id) on delete cascade
);

create table questions (
  hydra_id text not null,
  card_id text not null,
  id text not null,
  position integer not null check (position >= 0),
  audience text not null check (audience in ('hydra', 'owner')),
  question text not null,
  asked_at text not null,
  actor text not null,
  answered text,
  answered_at text,
  closed boolean not null,
  data json not null,
  -- Keyed by card too: a card moved in from another Hydra keeps the ids that Hydra gave its records.
  primary key (hydra_id, card_id, id),
  foreign key (hydra_id, card_id) references cards (hydra_id, id) on delete cascade
);

create table declarations (
  hydra_id text not null,
  card_id text not null,
  id text not null,
  position integer not null check (position >= 0),
  state text not null check (state in ('working', 'needs_you', 'paused', 'blocked', 'done')),
  note text not null,
  at text not null,
  actor text not null,
  until text,
  data json not null,
  primary key (hydra_id, card_id, id),
  foreign key (hydra_id, card_id) references cards (hydra_id, id) on delete cascade
);

create table links (
  hydra_id text not null,
  card_id text not null,
  url text not null,
  position integer not null check (position >= 0),
  kind text not null check (kind in ('github_pr', 'linear', 'url')),
  number integer,
  title text,
  state text check (state in ('open', 'merged', 'closed')),
  draft boolean,
  -- The question that decides this pull request's merge, among every card's merge questions for its url.
  merge_question_card text,
  merge_question text,
  data json not null,
  primary key (hydra_id, card_id, url),
  foreign key (hydra_id, card_id) references cards (hydra_id, id) on delete cascade
);

-- A card's notes. Each note's text is in the event that wrote it, which has the note's id; a card moved in from
-- another Hydra keeps notes whose events stay in that Hydra.
create table notes (
  hydra_id text not null,
  card_id text not null,
  id text not null,
  position integer not null check (position >= 0),
  kind text not null check (kind in ('summary', 'decision', 'context')),
  source text not null,
  at text,
  primary key (hydra_id, card_id, id),
  foreign key (hydra_id, card_id) references cards (hydra_id, id) on delete cascade
);

-- The conversation with Hydra: the owner's messages, workers' reports and Pnyx's lines, with each one's receipt.
create table messages (
  hydra_id text not null references hydras (id) on delete cascade,
  id text not null,
  position integer not null check (position >= 0),
  task_id text,
  action text not null check (action in ('send', 'worker')),
  kind text check (kind in ('progress', 'divider', 'routine')),
  text text not null,
  at text not null,
  actor text not null,
  -- When Hydra's harness confirmed it took the message.
  received text,
  data json not null,
  primary key (hydra_id, id)
);

create table sessions (
  hydra_id text not null references hydras (id) on delete cascade,
  id text not null,
  task_id text,
  data json not null,
  primary key (hydra_id, id)
);

-- The tables zero-cache replicates for the page; sessions, transactions and card_private stay with the server.
create publication pnyx_page for table hydras, hydra_queues, settings, upgrade_status, hydra_values, events, card_updates, columns,
  cards, card_bodies, card_references, replies, questions, declarations, links, notes, messages;

-- The schema version this file creates. A change to the tables bumps it, with a migration for databases on the older
-- one; a build refuses a database on a version it does not know instead of failing its writes.
create table schema_version (
  version integer primary key
);

insert into schema_version (version) values (4);
